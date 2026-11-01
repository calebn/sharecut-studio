from __future__ import annotations

import functools
import json
import logging
import math
import re
import shutil
import tempfile
import threading
from collections.abc import Callable, Generator, Iterable, Iterator
from contextlib import ExitStack, suppress
from dataclasses import asdict, dataclass, field
from itertools import pairwise
from pathlib import Path
from typing import IO, Any

import numpy as np

from podcast_mcp.engines.audio import (
    Audio,
    CrossfadeAudio,
    FrameTransform,
    MaskAudio,
    MixAudio,
    MuteEnvelope,
    MuteSampleEnvelope,
    OffSpeakerAudio,
    RequestedExtent,
    SequenceAudio,
    SilenceAudio,
    SourceAudio,
    SourceFrameMapping,
    SourceMuteEnvelope,
    delay_frames,
    fade_duration,
    postorder,
    sources,
)
from podcast_mcp.engines.effect_filters import format_effect, graph_rate
from podcast_mcp.engines.mastering import (
    LIMITER_MARGIN_DB,
    LIMITER_MAX_RENDERS,
    SCREEN_PEAK_SLACK_DB,
    TRUE_PEAK_PRINT_ROUNDING_DB,
    LimiterPlan,
    LimiterReport,
    LoudnormPlan,
    MasterResult,
    limiter_af,
    plan_master,
)
from podcast_mcp.engines.media_seek import MediaSeek
from podcast_mcp.engines.mix_spans import quiet_spans
from podcast_mcp.engines.mono_downmix import ffmpeg_mono_mean_layout
from podcast_mcp.engines.render_clock import (
    ClockBinding,
    clock_error,
    configure_observers,
    format_filter,
    graph_file,
    negotiated_rates,
    observed_clock,
    spawn_or_too_long,
)
from podcast_mcp.models import (
    AutomationEnvelope,
    EpisodeProject,
    ProcessingChain,
    ProcessingEffect,
    Track,
)
from podcast_mcp.util.atomic_file import publish_completed_file
from podcast_mcp.util.binaries import (
    FFmpegPair,
    FFmpegPairResolutionError,
    resolve_ffmpeg,
    resolve_ffmpeg_pair,
)
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.parallel import run_parallel
from podcast_mcp.util.pcm_stream import NoAudioDecodedError
from podcast_mcp.util.process import (
    DEVNULL,
    PIPE,
    CalledProcessError,
    TimeoutExpired,
    popen,
    run,
)
from podcast_mcp.util.progress import raise_if_cancel_requested
from podcast_mcp.util.project_state import FileRevision, file_revision

# Raw float32 PCM decode (waveform pyramid builds and deep-zoom windows). The
# timeouts are watchdogs armed only while waiting on ffmpeg for one chunk, so
# consumer time between chunks never counts toward them.
PCM_STREAM_CHUNK_FRAMES = 1_048_576
PCM_STREAM_TIMEOUT_SEC = 600.0
PCM_WINDOW_TIMEOUT_SEC = 30.0
# Bytes of ffmpeg stderr kept for a failed decode's error message.
PCM_STDERR_TAIL_BYTES = 2048
CANCEL_POLL_SEC = 0.1
ENCODE_CANCELLED = "Encoding cancelled"
# Guest-safe input protocols (same whitelist as ``probe(untrusted=True)``).
_UNTRUSTED_PROTOCOLS = "file,crypto,data"
_PACKET_SCAN_TIMEOUT_SEC = 120.0
MAX_PROBED_AUDIO_EXTENT_SEC = 7 * 24 * 3600.0
_PACKET_RECORD_BYTES = 4096
# Audio starting this much after the container start is a leading gap, not codec priming.
_AUDIO_START_GAP_SEC = 0.02


log = logging.getLogger(__name__)


def mute_gain_expression(envelopes: tuple[MuteSampleEnvelope, ...]) -> str:
    gains: list[tuple[str, str]] = []
    for samples in envelopes:
        first, last = samples.first, samples.last
        fade_out, fade_in = samples.fade_out, samples.fade_in
        floor = samples.gain
        if fade_out + fade_in > last - first:
            gains.append((str(first), f"if(gte(n,{first})*lt(n,{last}),{floor:g},1)"))
            continue
        span = 1.0 - floor
        expr = "1"
        if fade_in > 0:
            expr = (
                f"if(between(n,{last - fade_in},{last}),"
                f"{floor:g}+{span:g}*(n-({last - fade_in}))/{fade_in},1)"
            )
        expr = f"if(between(n,{first + fade_out},{last - fade_in}),{floor:g},{expr})"
        if fade_out > 0:
            expr = (
                f"if(between(n,{first},{first + fade_out}),"
                f"1-{span:g}*(n-({first}))/{fade_out},{expr})"
            )
        gains.append((str(first), expr))
    if not gains:
        return "1"

    def interval_tree(items: list[tuple[str, str]]) -> str:
        if len(items) == 1:
            return items[0][1]
        middle = len(items) // 2
        return (
            f"if(lt(n,{items[middle][0]}),"
            f"{interval_tree(items[:middle])},{interval_tree(items[middle:])})"
        )

    return interval_tree(gains)


def automatic_gain_expression(
    envelopes: tuple[SourceMuteEnvelope, ...],
    mapping: SourceFrameMapping,
    bypass_windows: tuple[tuple[float, float], ...] = (),
) -> str:
    gains = []
    for envelope in envelopes:
        first, fall, rise, last = (
            mapping.endpoint(envelope.start),
            mapping.endpoint(envelope.start + envelope.fade_out_sec),
            mapping.endpoint(envelope.end - envelope.fade_in_sec),
            mapping.endpoint(envelope.end),
        )
        if fall > rise:
            fall, rise = first, last
        falling = f"({fall}-n)/{fall - first}" if fall > first else "0"
        rising = f"(n-{rise})/{last - rise}" if last > rise else "1"
        gains.append(
            f"if(lt(n,{first}),1,if(lt(n,{fall}),{falling},if(lt(n,{rise}),0,if(lt(n,{last}),{rising},1))))"
        )
    gain = gains[0] if gains else "1"
    for other in gains[1:]:
        gain = f"min({gain},{other})"
    if bypass_windows:
        selected = "+".join(
            f"gte(n,{mapping.endpoint(start, ceil=True)})*lt(n,{mapping.endpoint(end, ceil=True)})"
            for start, end in bypass_windows
        )
        gain = f"if({selected},1,{gain})"
    return gain


# 3: use the completed graph's true-peak summary for headroom trim (#855).
MIX_SEMANTICS_REV = 3

MASTER_SEMANTICS_REV = 1


def _sample_frame_expression(offset: int, source_rate: int) -> str:
    sign = "-" if offset < 0 else ""
    return f"{sign}floor({abs(offset)}*s/{source_rate}+0.5)"


def _delay_filter(delay_sec: float, sample_rate: int) -> str:
    """Silence of ``delay_sec`` in front of the audio, with timestamps renumbered by sample.

    Placed on ``round(delay_sec * rate)`` samples, as the evaluation does (#2025, #2456).
    ``sample_rate`` is the rate the render graph negotiates at this delay: the leading
    ``aformat`` resamples the audio to it before ``adelay``, so the pin never moves the rate
    the mix runs at.
    The trailing ``aformat`` keeps ``adelay``'s out-link at that rate when a filter downstream
    of the mix forces another rate and the dry run disagrees with the real run (#2082).

    When ``atrim`` has cut the first frame on a seeked input, ``adelay`` emits its lead-in
    frames with no timestamp (``NOPTS``), and a later ``apad`` or ``atrim`` drops them: a
    1 s lead-in shrinks to 2048 samples. ``asetpts=N/SR/TB`` restamps every frame from
    its sample count, so the silence keeps its length.
    """
    pin = f"aformat=sample_rates={sample_rate}"
    frames = delay_frames(delay_sec, sample_rate)
    return f"{pin},adelay=delays={frames}S:all=1,asetpts=N/SR/TB,{pin}"


def _escape_filter_value(value: str) -> str:
    """Escape a value (e.g. a filesystem path) for an ffmpeg filtergraph option.

    Needed for values that may contain `:` (filter-option separator, also a
    Windows drive-letter separator) or `'`/`\\`.
    """
    return value.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _effect_filter(fx: ProcessingEffect) -> str | None:
    """Format one supported processing effect; preserve order in the caller."""
    return format_effect(fx.effect, fx.params)


_PROGRESS_TIME_RE = re.compile(r"^out_time_(?:us|ms)=(\d+)$")  # both are microseconds


def _progress_seconds(line: str) -> float | None:
    m = _PROGRESS_TIME_RE.match(line.strip())
    return int(m.group(1)) / 1_000_000 if m else None


_LOUDNORM_HEADER_RE = re.compile(r"^\[Parsed_loudnorm_\d+ @ [^\]\n]*\]", re.MULTILINE)


def _json_object_in(text: str) -> dict[str, Any] | None:
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _loudnorm_json(text: str) -> dict[str, Any] | None:
    # The report follows loudnorm's own log header; braces in a forged tag dumped earlier don't count.
    for header in reversed(list(_LOUDNORM_HEADER_RE.finditer(text))):
        report = _json_object_in(text[header.end() :])
        if report is not None:
            return report
    return _json_object_in(text)


_SUMMARY_TRUE_PEAK_RE = re.compile(r"Peak:\s*(-inf|-?\d+(?:\.\d+)?)\s*dBFS")
_EBUR128_BLOCK_RE = re.compile(r"\bt:\s*(\d+(?:\.\d+)?)\s+TARGET:.*?\bM:\s*(-?\d+(?:\.\d+)?)")

# Match on ``\n`` only, never ``str.splitlines()``, which also breaks on U+2028.
_FILTER_LOG_LINE_RE = re.compile(r"^\[Parsed_(\w+?)_\d+ @ ([^\]\n]*)\] ?([^\n]*)", re.MULTILINE)
_ANSI_SGR_RE = re.compile(r"\x1b\[[0-9;]*m")
_EMPTY_OUTPUT_RE = re.compile(r"^\[out#\d+/null @ [^\]\n]*\] Output file is empty", re.MULTILINE)
_EBUR128_SUMMARY_RE = re.compile(r"^\[Parsed_ebur128_\d+ @ [^\]\n]*\] Summary:", re.MULTILINE)


def _stderr_text(stderr: str | bytes | None) -> str:
    """ffmpeg stderr as text with ``\n`` line ends; undecodable tag bytes become U+FFFD."""
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", "replace")
    return _ANSI_SGR_RE.sub("", stderr or "").replace("\r\n", "\n").replace("\r", "\n")


def filter_log_text(stderr: str | bytes | None, filter_name: str) -> str:
    """Payloads of the stderr lines ``filter_name`` itself printed, newline-joined.

    Only lines from the instance that printed last (its ``@ <addr>``) count: the real filter logs
    after the metadata dump, and a forged line in a raw-printed tag key cannot know its address.
    """
    lines = [m for m in _FILTER_LOG_LINE_RE.finditer(_stderr_text(stderr)) if m[1] == filter_name]
    return "\n".join(m[3] for m in lines if m[2] == lines[-1][2]) if lines else ""


def decoded_no_frames(stderr: str | bytes | None) -> bool:
    return _EMPTY_OUTPUT_RE.search(_stderr_text(stderr)) is not None


def ebur128_summary_text(stderr: str | bytes | None) -> str:
    text = _stderr_text(stderr)
    starts = [m.end() for m in _EBUR128_SUMMARY_RE.finditer(text)]
    return text[starts[-1] :] if starts else ""


def headroom_trim_db(true_peak_db: float | None, ceiling_db: float) -> float:
    """Gain (<= 0 dB) that brings a mix's true peak down to ``ceiling_db``; never boosts."""
    if true_peak_db is None:
        return 0.0
    return min(0.0, round(ceiling_db - true_peak_db, 2))


def _concat_list_entry(path: Path) -> str:
    """Format one ``file '...'`` line for the concat demuxer (quote-safe)."""
    resolved = str(path.resolve())
    if "\n" in resolved or "\r" in resolved:
        raise CodedValueError(
            f"media path must not contain newlines: {Path(resolved).name!r}. Rename the file so its path has no line break.",
            code="media_path_invalid",
        )
    # FFmpeg concat: escape embedded single quotes as '\''
    escaped = resolved.replace("'", r"'\''")
    return f"file '{escaped}'"


_FONT_CANDIDATES = (
    Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
    Path("/Library/Fonts/Arial.ttf"),
    Path("/System/Library/Fonts/Helvetica.ttc"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    Path("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"),
    Path("/usr/share/fonts/TTF/DejaVuSans.ttf"),
)

_MARK_COLORS = {
    "hypothesis": "red",
    "pending_edit": "orange",
    "comment": "yellow",
    "word": "white",
}

# Visual diagnostics run from the GUI and in parallel pytest-xdist workers.  FFmpeg's
# automatic decoder/filter thread counts can otherwise multiply host CPU and memory
# usage once per rendered track, so image-only diagnostics are deliberately bounded.
_VISUAL_DIAGNOSTIC_THREAD_ARGS = (
    "-threads",
    "1",
    "-filter_threads",
    "1",
    "-filter_complex_threads",
    "1",
)


def _drawtext_font() -> Path | None:
    for path in _FONT_CANDIDATES:
        if path.is_file():
            return path
    return None


def _escape_drawtext(text: str) -> str:
    cleaned = "".join(" " if ord(ch) < 32 else ch for ch in text)
    return cleaned.replace("\\", "\\\\").replace("'", r"\'").replace(":", r"\:").replace("%", r"\%")


def _annotate_vf(
    marks: list[dict[str, Any]],
    *,
    plot_width: int,
    window_start: float | None,
    window_end: float | None,
    font: Path | None,
    use_drawtext: bool,
) -> str:
    """Build a comma-joined vf for time-mark overlay. Empty if nothing to draw."""
    filters: list[str] = []
    for mark in marks:
        x_frac = max(0.0, min(1.0, float(mark.get("x", 0.0))))
        x_px = round(x_frac * plot_width)
        kind = str(mark.get("kind") or "word")
        color = _MARK_COLORS.get(kind, "white")
        filters.append(f"drawbox=x={x_px}:y=0:w=2:h=ih:color={color}@0.85:t=fill")
        label = mark.get("label")
        if use_drawtext and font is not None and label:
            text = _escape_drawtext(str(label)[:24])
            fontfile = _escape_filter_value(str(font))
            filters.append(
                f"drawtext=fontfile={fontfile}:text='{text}':"
                f"x={x_px}+4:y=8:fontsize=14:fontcolor=white:"
                "box=1:boxcolor=black@0.55"
            )
    if use_drawtext and font is not None and window_start is not None and window_end is not None:
        fontfile = _escape_filter_value(str(font))
        left = _escape_drawtext(f"{window_start:.1f}s")
        right = _escape_drawtext(f"{window_end:.1f}s")
        filters.append(
            f"drawtext=fontfile={fontfile}:text='{left}':x=8:y=h-22:"
            "fontsize=12:fontcolor=white:box=1:boxcolor=black@0.55"
        )
        filters.append(
            f"drawtext=fontfile={fontfile}:text='{right}':x=w-72:y=h-22:"
            "fontsize=12:fontcolor=white:box=1:boxcolor=black@0.55"
        )
    return ",".join(filters)


LATE_MPEG_AUDIO_MESSAGE = "audio starts late in an MPEG transport stream; re-encode it"


class LateMpegAudioError(CodedValueError):
    def __init__(self) -> None:
        super().__init__(LATE_MPEG_AUDIO_MESSAGE, code="invalid_audio")


@dataclass
class AudioProbe:
    # Length of the first audio stream, counted from its first sample.
    duration_sec: float
    sample_rate: int
    channels: int
    # How far that first sample sits past the container start; 0.0 at or below codec priming.
    audio_start_sec: float = field(kw_only=True)
    # True when ffmpeg rebases this file's audio-only reads while `-ss` keeps the container clock,
    # so a nonzero ``audio_start_sec`` cannot place a windowed read (MPEG-TS and MPEG-PS).
    rebases_audio_reads: bool = field(kw_only=True)
    duration_estimated: bool = False
    audio_duration_sec: float | None = None
    # The decoder's sample format (``s16``, ``fltp``, ...), when ffprobe reports one.
    sample_fmt: str | None = None
    # Audio streams in the file.
    audio_stream_count: int = 1
    # Audio stream FFmpeg's automatic pick chose before analysis read the first one
    # (default-flagged, else most channels, lowest index on ties); None when ffprobe
    # lacked the fields to tell. The packet-count term of FFmpeg's score is not modelled.
    legacy_default_audio_index: int | None = 0

    def require_duration_sec(self, *, maximum_sec: float | None = None) -> float:
        """Return a known positive first-audio extent suitable for stored geometry."""
        if (
            self.duration_estimated
            or self.audio_stream_count < 1
            or not math.isfinite(self.duration_sec)
            or self.duration_sec <= 0
            or (maximum_sec is not None and self.duration_sec > maximum_sec)
        ):
            if self.rebases_audio_reads:
                raise LateMpegAudioError
            raise CodedValueError(
                "audio duration is unavailable or outside its bound", code="invalid_audio"
            )
        return self.duration_sec


def _legacy_audio_pick(audio_streams: list[dict[str, Any]]) -> int | None:
    scores: list[tuple[int, int]] = []
    for s in audio_streams:
        default = (s.get("disposition") or {}).get("default")
        channels = s.get("channels")
        if default is None or channels is None:
            return None if len(audio_streams) > 1 else 0
        scores.append((int(default), int(channels)))
    return max(range(len(scores)), key=lambda k: (scores[k], -k), default=0)


def _seconds(value: Any) -> float | None:
    """A finite float from an ffprobe field, or None for "N/A", empty or non-finite."""
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    return seconds if math.isfinite(seconds) else None


def _rebases_audio_only_reads(probe_json: dict[str, Any]) -> bool:
    """MPEG-TS and MPEG-PS: ffmpeg zeroes an audio-only read's clock while `-ss` keeps the container's."""
    names = str(probe_json.get("format", {}).get("format_name", "")).split(",")
    return "mpegts" in names or "mpeg" in names


def _stream_duration_unreliable(probe_json: dict[str, Any]) -> bool:
    """Containers whose declarations can omit packets or later logical streams."""
    names = str(probe_json.get("format", {}).get("format_name", ""))
    if "mpegts" in names or "ogg" in names:
        return True
    if "matroska" not in names and "webm" not in names:
        return False
    return any(
        s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")
        for s in probe_json.get("streams", [])
    )


class _AudioExtentUnavailable(Exception):
    pass


def _read_audio_extent(ffprobe: str, path: str, *, untrusted: bool) -> tuple[float, float]:
    cmd = [
        ffprobe,
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "packet=pts_time,duration_time",
        "-of",
        "csv=p=0",
    ]
    if untrusted:
        cmd.extend(["-protocol_whitelist", _UNTRUSTED_PROTOCOLS])
    cmd.append(path)
    proc = popen(cmd, stdout=PIPE, stderr=DEVNULL)
    lock = threading.Lock()
    expired = False
    finished = False

    def expire() -> None:
        nonlocal expired
        with lock:
            if not finished:
                expired = True
                with suppress(OSError):
                    proc.kill()

    timer = threading.Timer(_PACKET_SCAN_TIMEOUT_SEC, expire)
    timer.daemon = True
    end = 0.0
    first_pts: float | None = None
    previous_pts: float | None = None
    try:
        timer.start()
        assert proc.stdout is not None
        while line := proc.stdout.readline(_PACKET_RECORD_BYTES):
            if len(line) == _PACKET_RECORD_BYTES and not line.endswith(b"\n"):
                raise _AudioExtentUnavailable
            fields = line.split(b",")
            pts = _seconds(fields[0])
            if pts is None:
                continue
            if previous_pts is not None and pts <= previous_pts:
                raise _AudioExtentUnavailable
            previous_pts = pts
            if first_pts is None:
                first_pts = pts
            duration = _seconds(fields[1]) if len(fields) > 1 else None
            if duration is not None and duration < 0:
                raise _AudioExtentUnavailable
            packet_end = pts + (duration or 0.0)
            if not math.isfinite(packet_end):
                raise _AudioExtentUnavailable
            end = max(end, packet_end)
        rc = proc.wait()
        with lock:
            finished = True
            if expired or rc or end <= 0 or first_pts is None:
                raise _AudioExtentUnavailable
        return first_pts, end
    finally:
        with lock:
            finished = True
        timer.cancel()
        if proc.poll() is None:
            proc.kill()
        if proc.stdout is not None:
            proc.stdout.close()
        proc.wait()


@functools.lru_cache(maxsize=1024)
def _cached_audio_extent(
    ffprobe: str, binary_revision: FileRevision, path: str, revision: FileRevision, untrusted: bool
) -> tuple[float, float]:
    extent = _read_audio_extent(ffprobe, path, untrusted=untrusted)
    if file_revision(Path(path)) != revision or file_revision(Path(ffprobe)) != binary_revision:
        raise _AudioExtentUnavailable
    return extent


def _read_exact(stream: IO[bytes], size: int) -> bytearray:
    """Read *size* bytes, looping on short pipe reads; shorter only at EOF."""
    buf = bytearray()
    while len(buf) < size:
        part = stream.read(size - len(buf))
        if not part:
            break
        buf += part
    return buf


def _mono_chunks(chunks: Generator[np.ndarray, None, None]) -> Generator[np.ndarray, None, None]:
    """``(frames, 1)`` chunks as 1-D arrays; closing this closes (and kills) the decode."""
    try:
        for chunk in chunks:
            yield chunk.reshape(-1)
    finally:
        chunks.close()


def _run_cancellable(cmd: list[str], cancel_check: Callable[[], bool]) -> None:
    """Run ``cmd``; kill it and raise ``CancelledProgress`` once ``cancel_check()`` is true.

    A nonzero exit after a cancel was requested is the cancel too, not a failure: the
    child may have been stopped by the same interrupt (#1164).
    """
    with (
        tempfile.TemporaryFile() as err,
        spawn_or_too_long(popen, cmd, stdout=DEVNULL, stderr=err) as proc,
    ):
        try:
            while True:
                try:
                    rc = proc.wait(timeout=CANCEL_POLL_SEC)
                    break
                except TimeoutExpired:
                    raise_if_cancel_requested(cancel_check, ENCODE_CANCELLED)
        except BaseException:
            proc.kill()
            proc.wait()
            raise
        if rc != 0:
            raise_if_cancel_requested(cancel_check, ENCODE_CANCELLED)
            err.seek(0)
            raise CalledProcessError(rc, cmd, stderr=err.read())


def _pcm_decode_error(code: int, timed_out: bool, timeout_sec: float, err: IO[bytes]) -> str:
    """``RuntimeError`` text for a failed PCM decode: exit code, watchdog, stderr tail."""
    msg = f"ffmpeg PCM decode failed (exit {code})"
    if timed_out:
        msg += f"; killed by the {timeout_sec:g} s watchdog"
    err.seek(0, 2)
    err.seek(max(0, err.tell() - PCM_STDERR_TAIL_BYTES))
    tail = err.read().decode("utf-8", "replace").strip()
    return f"{msg}: {tail}" if tail else msg


def _mask_endpoint(
    seconds: float, rate: int, origin: int, transforms: tuple[FrameTransform, ...]
) -> str:
    if transforms:
        return str(SourceFrameMapping(rate, 0, transforms).endpoint(seconds, ceil=True))
    return _sample_frame_expression(math.ceil(seconds * rate) - origin, rate)


class FFmpegEngine:
    def __init__(
        self,
        ffmpeg: str | None = None,
        ffprobe: str | None = None,
        *,
        _admitted_pair: FFmpegPair | None = None,
    ) -> None:
        pair = _admitted_pair or resolve_ffmpeg_pair(ffmpeg, ffprobe)
        self.ffmpeg = pair.ffmpeg
        self.ffprobe = pair.ffprobe
        self.source = pair.source
        self._listed_names_cache: dict[str, set[str]] = {}

    @staticmethod
    def astats(path: Path, *, ffmpeg: str | None = None) -> dict[str, float | int | None]:
        """Objective per-file health stats via ffmpeg's astats filter.

        Call on the class. Instance binary overrides do not apply.

        Some fields (e.g. Crest factor, Dynamic range) are only printed once in the
        per-channel section for mono audio, not repeated under "Overall" - we take the
        last occurrence of each label across the filter's own lines rather than slicing
        to the "Overall" section, so both kinds of fields are captured correctly.
        """
        cmd = [
            ffmpeg or resolve_ffmpeg(),
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-af",
            "astats=metadata=1:reset=0",
            "-f",
            "null",
            "-",
        ]
        r = run(cmd, capture_output=True)
        ok = r.returncode == 0 and not decoded_no_frames(r.stderr)
        text = filter_log_text(r.stderr, "astats") if ok else ""

        def _grab(label: str) -> float | None:
            matches = re.findall(
                rf"^[ \t]*{re.escape(label)}:\s*(-?inf|-?[\d.]+)", text, re.MULTILINE
            )
            if not matches:
                return None
            val = matches[-1]
            if val in ("inf", "-inf"):
                return None
            return float(val)

        peak_count = _grab("Peak count")
        return {
            "dc_offset": _grab("DC offset"),
            "peak_level_db": _grab("Peak level dB"),
            "rms_level_db": _grab("RMS level dB"),
            "crest_factor": _grab("Crest factor"),
            "flat_factor": _grab("Flat factor"),
            "peak_count": round(peak_count) if peak_count is not None else None,
            "noise_floor_db": _grab("Noise floor dB"),
            "dynamic_range_db": _grab("Dynamic range"),
        }

    @staticmethod
    def resample_streams(
        chunks: Iterator[np.ndarray], from_rate: int, to_rates: Iterable[int]
    ) -> dict[int, np.ndarray]:
        """Convert mono chunks to each requested rate with state across chunk edges.

        Call on the class. Each converted target resolves its binary through
        ``resolve_ffmpeg_pair``. Instance binary overrides do not apply.
        A source-rate target retains the chunks. A failed conversion raises
        ``CalledProcessError``, as a failed decode does.
        """
        rates = tuple(dict.fromkeys(to_rates))
        converting = [rate for rate in rates if rate != from_rate]
        if not converting:
            return dict.fromkeys(rates, np.concatenate(list(chunks)))
        commands = {
            rate: [
                resolve_ffmpeg_pair().ffmpeg,
                "-v",
                "error",
                "-f",
                "f32le",
                "-ar",
                str(from_rate),
                "-ac",
                "1",
                "-i",
                "pipe:0",
                "-ar",
                str(rate),
                "-f",
                "f32le",
                "pipe:1",
            ]
            for rate in converting
        }
        processes = {
            rate: popen(command, stdin=PIPE, stdout=PIPE, stderr=PIPE)
            for rate, command in commands.items()
        }
        kept: list[np.ndarray] = []
        failure: list[BaseException] = []

        def feed() -> None:
            open_pipes = {rate: process.stdin for rate, process in processes.items()}
            try:
                for chunk in chunks:
                    data = np.ascontiguousarray(chunk, dtype="<f4")
                    if from_rate in rates:
                        kept.append(data)
                    payload = data.tobytes()
                    for rate, pipe in list(open_pipes.items()):
                        assert pipe is not None
                        try:
                            pipe.write(payload)
                        except BrokenPipeError:
                            del open_pipes[rate]
            except BaseException as exc:
                failure.append(exc)
            finally:
                for pipe in open_pipes.values():
                    with suppress(BrokenPipeError):
                        assert pipe is not None
                        pipe.close()

        converted: dict[int, tuple[bytes, bytes]] = {}

        def collect(rate: int) -> None:
            process = processes[rate]
            assert process.stdout is not None and process.stderr is not None
            converted[rate] = (process.stdout.read(), process.stderr.read())

        collectors = [
            threading.Thread(target=collect, args=(rate,), daemon=True) for rate in converting
        ]
        feeder = threading.Thread(target=feed, daemon=True)
        for thread in (*collectors, feeder):
            thread.start()
        for thread in (feeder, *collectors):
            thread.join()
        codes = {rate: process.wait() for rate, process in processes.items()}
        if failure:
            raise failure[0]
        for rate, code in codes.items():
            if code != 0:
                raise CalledProcessError(code, commands[rate], stderr=converted[rate][1])
        results = {rate: np.frombuffer(converted[rate][0], dtype="<f4") for rate in converting}
        if from_rate in rates:
            results[from_rate] = np.concatenate(kept)
        return {rate: results[rate] for rate in rates}

    def decode_full_f32(self, path: Path, *, sample_rate: int, layout: list[str]) -> np.ndarray:
        """Decode the first audio stream into a nonempty flat float32 byte view."""
        result = run(
            [
                self.ffmpeg,
                "-v",
                "error",
                "-i",
                str(path),
                "-map",
                "0:a:0",
                *layout,
                "-ar",
                str(sample_rate),
                "-f",
                "f32le",
                "pipe:1",
            ],
            capture_output=True,
            check=True,
        )
        samples = np.frombuffer(result.stdout, dtype=np.float32)
        if samples.size == 0:
            raise NoAudioDecodedError(path)
        return samples

    def check_available(self) -> tuple[bool, str]:
        try:
            pair = resolve_ffmpeg_pair(self.ffmpeg, self.ffprobe, force_refresh=True)
        except FFmpegPairResolutionError as exc:
            return False, str(exc)
        return True, "FFmpeg/FFprobe " + ".".join(map(str, pair.version))

    def audio_start_sec(self, path: Path) -> float:
        """How far ``path``'s first audio sample sits past its container start."""
        from podcast_mcp.engines.media_probe import audio_start_sec

        return audio_start_sec(path)

    def probe(self, path: Path, *, untrusted: bool = False) -> AudioProbe:
        cmd = [
            self.ffprobe,
            "-v",
            "warning",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ]
        if untrusted:
            # Guest uploads: do not follow concat:/file: demuxer tricks.
            cmd.extend(["-protocol_whitelist", _UNTRUSTED_PROTOCOLS])
        cmd.append(str(path))
        r = run(cmd, capture_output=True, text=True, check=True, timeout=_PACKET_SCAN_TIMEOUT_SEC)
        data = json.loads(r.stdout)
        audio_streams = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]
        stream: dict[str, Any] = audio_streams[0] if audio_streams else {}
        fmt = data.get("format", {})
        container = _seconds(fmt.get("duration"))
        audio_duration = _seconds(stream.get("duration"))
        duration = container or audio_duration or 0.0
        bitrate_estimated = "estimating duration from bitrate" in (r.stderr or "").lower()
        if bitrate_estimated:
            audio_duration = None
        scan_failed = False
        rebases_reads = False
        audio_start = 0.0
        scan_end: float | None = None
        if audio_streams:
            container_start = _seconds(fmt.get("start_time")) or 0.0
            audio_start = (_seconds(stream.get("start_time")) or 0.0) - container_start
            if (
                not (audio_duration and audio_duration > 0)
                or bitrate_estimated
                or _stream_duration_unreliable(data)
            ):
                scan = self._scan_audio_extent(path, untrusted=untrusted)
                # Container headers can be stale or short, so they never bound the scan; only an
                # impossible value (a forged pts) fails it.
                if scan is None or not 0 < scan[1] - scan[0] <= MAX_PROBED_AUDIO_EXTENT_SEC:
                    scan_failed = True
                else:
                    audio_start = scan[0] - container_start
                    scan_end = scan[1]
            else:
                duration = audio_duration
            if audio_start > _AUDIO_START_GAP_SEC:
                # Priming and pre-skip sit in the first packet's pts but not in the decoded audio.
                decoded = self._first_decoded_pts(path, untrusted=untrusted)
                if decoded is not None:
                    audio_start = decoded - container_start
            else:
                audio_start = 0.0
            if scan_end is not None:
                duration = scan_end - container_start - audio_start
            # A forged start would push every seek out of range, like a forged extent.
            scan_failed = scan_failed or audio_start > MAX_PROBED_AUDIO_EXTENT_SEC
            rebases_reads = audio_start > _AUDIO_START_GAP_SEC and _rebases_audio_only_reads(data)
            scan_failed = scan_failed or rebases_reads
        return AudioProbe(
            duration_sec=duration,
            sample_rate=int(stream.get("sample_rate") or 48000),
            channels=int(stream.get("channels") or 1),
            audio_start_sec=audio_start,
            rebases_audio_reads=rebases_reads,
            duration_estimated=not audio_streams or scan_failed or not math.isfinite(duration),
            audio_duration_sec=audio_duration,
            sample_fmt=stream.get("sample_fmt") or None,
            audio_stream_count=len(audio_streams),
            legacy_default_audio_index=_legacy_audio_pick(audio_streams),
        )

    def _first_decoded_pts(self, path: Path, *, untrusted: bool) -> float | None:
        cmd = [
            self.ffprobe,
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-read_intervals",
            "%+#4",
            "-show_entries",
            "frame=pts_time",
            "-of",
            "csv=p=0",
        ]
        if untrusted:
            cmd.extend(["-protocol_whitelist", _UNTRUSTED_PROTOCOLS])
        cmd.append(str(path))
        r = run(cmd, capture_output=True, text=True, timeout=_PACKET_SCAN_TIMEOUT_SEC)
        lines = r.stdout.split() if r.returncode == 0 else []
        return _seconds(lines[0].rstrip(",")) if lines else None

    def _scan_audio_extent(self, path: Path, *, untrusted: bool) -> tuple[float, float] | None:
        """a:0's first packet pts and the end of its last packet, or None when the scan fails."""
        try:
            resolved = path.resolve()
            binary = Path(self.ffprobe).resolve()
            return _cached_audio_extent(
                str(binary),
                file_revision(binary),
                str(resolved),
                file_revision(resolved),
                untrusted,
            )
        except (OSError, _AudioExtentUnavailable):
            return None

    def stream_pcm_f32(
        self, path: Path, *, chunk_frames: int = PCM_STREAM_CHUNK_FRAMES
    ) -> tuple[int, int, Generator[np.ndarray, None, None]]:
        """Decode *path* to interleaved float32 PCM at its native rate and layout.

        Returns ``(sample_rate, channels, chunks)``; each chunk is a
        ``(frames, channels)`` float32 array of ``chunk_frames`` frames (the
        last may be shorter). ffmpeg starts on first ``next()`` and is killed
        when the generator closes, or when one chunk waits on ffmpeg longer than
        ``PCM_STREAM_TIMEOUT_SEC`` (the consumer's time between chunks does not
        count). A non-zero exit raises ``RuntimeError`` with the tail of ffmpeg's
        stderr. A successful whole-file exit also raises when the normalized
        final output timestamp is materially short of the declared audio-stream
        duration. Timestamp gaps retain the decoder's packed PCM samples.
        """
        if chunk_frames < 1:
            raise CodedValueError("chunk_frames must be >= 1", code="invalid_arguments")
        info = self.probe(path, untrusted=True)
        sample_rate, channels = info.sample_rate, max(1, info.channels)
        argv = self._pcm_f32_argv(path, sample_rate, channels)
        expected_duration = info.audio_duration_sec
        if (
            info.duration_estimated
            or info.audio_stream_count != 1
            or expected_duration is None
            or expected_duration <= 0
        ):
            expected_duration = None
        return (
            sample_rate,
            channels,
            self._read_pcm_f32(
                argv,
                channels,
                chunk_frames=chunk_frames,
                timeout_sec=PCM_STREAM_TIMEOUT_SEC,
                expected_duration_sec=expected_duration,
            ),
        )

    def stream_mono_f32(
        self, path: Path, *, sample_rate: int, chunk_frames: int = PCM_STREAM_CHUNK_FRAMES
    ) -> Generator[np.ndarray, None, None]:
        """Decode *path* downmixed to mono at ``sample_rate`` as 1-D float32 chunks.

        The streaming counterpart of ``engines.ungated_audio.load_mono_full`` (the same
        channel-mean mono downmix, so the concatenated chunks equal its array) for
        callers that must not hold a whole multi-hour track. Chunks are ``chunk_frames``
        long (the last may be shorter). Same process lifetime, watchdog and error
        reporting as :meth:`stream_pcm_f32`; arguments are validated eagerly.
        """
        if chunk_frames < 1 or sample_rate < 1:
            raise CodedValueError(
                "chunk_frames and sample_rate must be >= 1", code="invalid_arguments"
            )
        argv = self._pcm_f32_argv(path, sample_rate, 1)
        return _mono_chunks(
            self._read_pcm_f32(
                argv, 1, chunk_frames=chunk_frames, timeout_sec=PCM_STREAM_TIMEOUT_SEC
            )
        )

    def encode_flac_f32(
        self,
        chunks: Iterable[np.ndarray],
        output_path: Path,
        *,
        sample_rate: int,
        channels: int,
    ) -> Path:
        """Encode ``(frames, channels)`` float32 chunks to 24-bit FLAC at *output_path*.

        The counterpart of :meth:`stream_pcm_f32` for writing: chunks are piped to
        ffmpeg as they come, so a whole track is never held. Raises ``RuntimeError``
        with the tail of ffmpeg's stderr on a non-zero exit.
        """
        if sample_rate < 1 or channels < 1:
            raise CodedValueError("sample_rate and channels must be >= 1", code="invalid_arguments")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        argv = [
            self.ffmpeg,
            "-v",
            "error",
            "-y",
            "-f",
            "f32le",
            "-ar",
            str(sample_rate),
            "-ac",
            str(channels),
            "-i",
            "pipe:0",
            "-c:a",
            "flac",
            "-sample_fmt",
            "s32",
            "-bits_per_raw_sample",
            "24",
            str(output_path),
        ]
        with tempfile.TemporaryFile() as err, popen(argv, stdin=PIPE, stderr=err) as proc:
            assert proc.stdin is not None
            try:
                for chunk in chunks:
                    block = np.asarray(chunk, dtype="<f4").reshape(-1, channels)
                    proc.stdin.write(block.tobytes())
            finally:
                proc.stdin.close()
            code = proc.wait()
            if code:
                err.seek(0)
                tail = err.read()[-2000:].decode("utf-8", "replace")
                raise RuntimeError(f"ffmpeg FLAC encode failed ({code}): {tail}")
        return output_path

    def decode_window_f32(
        self, path: Path, start_frame: int, frames: int, sample_rate: int, channels: int
    ) -> np.ndarray:
        """Decode ``frames`` frames from ``start_frame`` as ``(n, channels)`` float32.

        ``n < frames`` only at end of media. Bounded by the ``PCM_WINDOW_TIMEOUT_SEC`` watchdog.
        """
        if start_frame < 0 or frames < 0 or sample_rate < 1 or channels < 1:
            raise CodedValueError("invalid PCM window", code="invalid_arguments")
        if frames == 0:
            return np.zeros((0, channels), dtype=np.float32)
        # ``-frames:a`` counts decoder packets, not samples, so the read below
        # stops at exactly ``frames``; ``-t`` (with slack) only bounds the decode.
        argv = self._pcm_f32_argv(
            path,
            sample_rate,
            channels,
            start_sec=start_frame / sample_rate,
            duration_sec=(frames + 64) / sample_rate,
        )
        parts = list(
            self._read_pcm_f32(
                argv,
                channels,
                chunk_frames=frames,
                timeout_sec=PCM_WINDOW_TIMEOUT_SEC,
                max_frames=frames,
            )
        )
        if not parts:
            return np.zeros((0, channels), dtype=np.float32)
        return np.concatenate(parts)

    def _pcm_f32_argv(
        self,
        path: Path,
        sample_rate: int,
        channels: int,
        *,
        start_sec: float | None = None,
        duration_sec: float | None = None,
    ) -> list[str]:
        argv = [
            self.ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-v",
            "error",
            "-protocol_whitelist",
            _UNTRUSTED_PROTOCOLS,
            "-threads",
            "1",
        ]
        lead_sec = 0.0 if start_sec is None else self.audio_start_sec(path)
        seek = MediaSeek.at(start_sec or 0.0, lead_sec=lead_sec)
        argv += [
            *seek.input_args(),
            "-i",
            str(path),
            "-map",
            "0:a:0",
            *seek.output_args(duration_sec),
        ]
        layout = ffmpeg_mono_mean_layout(path) if channels == 1 else ["-ac", str(channels)]
        argv += ["-f", "f32le", *layout, "-ar", str(sample_rate), "pipe:1"]
        return argv

    @staticmethod
    def _read_pcm_f32(
        argv: list[str],
        channels: int,
        *,
        chunk_frames: int,
        timeout_sec: float,
        max_frames: int | None = None,
        expected_duration_sec: float | None = None,
    ) -> Generator[np.ndarray, None, None]:
        if expected_duration_sec is not None:
            body = list(argv[1:-1])
            try:
                af_idx = body.index("-af")
                body[af_idx + 1] = f"{body[af_idx + 1]},asetpts=PTS-STARTPTS"
            except ValueError:
                body += ["-af", "asetpts=PTS-STARTPTS"]
            argv = [argv[0], "-progress", "pipe:2", *body, argv[-1]]
        with tempfile.TemporaryFile() as err:
            proc = popen(argv, stdout=PIPE, stderr=err)
            timed_out = threading.Event()

            watch_lock = threading.Lock()
            # Generation of the armed watchdog (0 = disarmed). Each chunk arms a
            # new one, so a timer from an earlier chunk that runs late is stale.
            armed = 0

            def _watchdog(gen: int) -> None:
                # A timer that fires after its chunk's read (and EOF wait)
                # finished, even once the next chunk has armed, is ignored.
                with watch_lock:
                    if armed != gen:
                        return
                    timed_out.set()
                    proc.kill()

            timer: threading.Timer | None = None
            frame_bytes = 4 * channels
            remaining = max_frames
            gen = 0
            try:
                stdout = proc.stdout
                if stdout is None:
                    raise RuntimeError("ffmpeg stdout pipe missing")
                while remaining is None or remaining > 0:
                    want = chunk_frames if remaining is None else min(chunk_frames, remaining)
                    # Armed only while waiting on ffmpeg: time the consumer spends
                    # between chunks (level builds, a busy pool) never counts.
                    gen += 1
                    with watch_lock:
                        armed = gen
                    timer = threading.Timer(timeout_sec, functools.partial(_watchdog, gen))
                    timer.daemon = True
                    timer.start()
                    buf = _read_exact(stdout, want * frame_bytes)
                    short = len(buf) < want * frame_bytes
                    code = proc.wait() if short else 0
                    with watch_lock:
                        armed = 0
                    timer.cancel()
                    frames = len(buf) // frame_bytes
                    if frames:
                        if remaining is not None:
                            remaining -= frames
                        yield np.frombuffer(buf, dtype="<f4", count=frames * channels).reshape(
                            frames, channels
                        )
                    if short:
                        if code != 0:
                            raise RuntimeError(
                                _pcm_decode_error(code, timed_out.is_set(), timeout_sec, err)
                            )
                        if expected_duration_sec is not None:
                            err.seek(0, 2)
                            err.seek(max(0, err.tell() - PCM_STDERR_TAIL_BYTES))
                            records = err.read().decode("utf-8", "replace").split("progress=")
                            final = (
                                records[-2]
                                if len(records) > 1 and records[-1].strip() == "end"
                                else ""
                            )
                            done_sec = next(
                                (
                                    seconds
                                    for line in reversed(final.splitlines())
                                    if (seconds := _progress_seconds(line)) is not None
                                ),
                                None,
                            )
                            if done_sec is None:
                                raise RuntimeError("ffmpeg PCM decode has no final timestamp")
                            if done_sec + 0.25 < expected_duration_sec:
                                raise RuntimeError(
                                    f"ffmpeg PCM decode ended short: {done_sec:.3f} s "
                                    f"of {expected_duration_sec:.3f} s"
                                )
                        return
            finally:
                if timer is not None:
                    timer.cancel()
                if proc.poll() is None:
                    proc.kill()
                proc.wait()

    def build_track_filter(
        self,
        chain: ProcessingChain | None,
        envelope: AutomationEnvelope | None,
        *,
        timeline_origin_sec: float = 0.0,
    ) -> str:
        if not math.isfinite(timeline_origin_sec) or timeline_origin_sec < 0:
            raise CodedValueError(
                "timeline_origin_sec must be finite and nonnegative", code="invalid_arguments"
            )
        filters: list[str] = []
        if chain:
            for fx in chain.effects:
                if not fx.bypass:
                    rendered = _effect_filter(fx)
                    if rendered is not None:
                        filters.append(rendered)
        if envelope and envelope.points:
            expr = self._volume_expression(envelope, timeline_origin_sec=timeline_origin_sec)
            filters.append(f"volume=volume='{expr}':eval=frame")
        if not filters:
            return "anull"
        return ",".join(filters)

    def _volume_expression(
        self, envelope: AutomationEnvelope, *, timeline_origin_sec: float = 0.0
    ) -> str:
        pts = sorted(envelope.points, key=lambda p: p.time)
        if not pts:
            return "1"
        if len(pts) == 1:
            return str(pts[0].value)
        clock = "t" if timeline_origin_sec == 0 else f"(t+{timeline_origin_sec})"
        expr = str(pts[-1].value)
        for left, right in reversed(list(pairwise(pts))):
            if right.time == left.time:
                continue
            slope = (right.value - left.value) / (right.time - left.time)
            interval = f"{left.value}+({clock}-{left.time})*{slope}"
            expr = f"if(lt({clock},{right.time}),{interval},{expr})"
        return f"if(lt({clock},{pts[0].time}),{pts[0].value},{expr})"

    def _fade_chain(
        self,
        seg_duration: float,
        fade_in_sec: float,
        fade_out_sec: float,
    ) -> list[str]:
        parts: list[str] = []
        if fade_in_sec > 0:
            d = fade_duration(seg_duration, fade_in_sec)
            parts.append(f"afade=t=in:st=0:d={d}")
        if fade_out_sec > 0:
            d = fade_duration(seg_duration, fade_out_sec)
            st = max(0.0, seg_duration - d)
            parts.append(f"afade=t=out:st={st}:d={d}")
        return parts

    def _mute_chain(
        self,
        seg_duration: float,
        mute_spans: tuple[MuteEnvelope, ...],
        *,
        sample_rate: int,
        source_start: float = 0.0,
        origin: int = 0,
    ) -> list[str]:
        """Gain that ramps to zero over each region's fade-out and back over its fade-in.

        ``mute_spans`` are seconds after ``source_start``; ``origin`` is the source
        sample the segment's first output sample holds (``MediaSeek.first_sample``).
        They never overlap (``mute_regions.mute_spans_for_source_window``). A region
        too short for both fades is muted outright.
        """
        from podcast_mcp.engines.mute_regions import sample_mute_envelopes

        envelopes = sample_mute_envelopes(
            mute_spans, seg_duration, sample_rate, source_start=source_start, origin=origin
        )
        if not envelopes:
            return []
        expr = mute_gain_expression(envelopes)
        return [f"aeval=exprs='val(ch)*({expr})':c=same"]

    def render_timeline(
        self,
        output_path: Path,
        audio: Audio,
        af_chain: str,
        *,
        crossfade_curve: str = "tri",
        requested_extent: RequestedExtent | None = None,
        clock_path: Path | None = None,
    ) -> Path:
        """Compile prepared audio with grouped bounded inputs and continuous track FX."""
        if clock_path is None and any(
            isinstance(node, OffSpeakerAudio) for node in postorder(audio)
        ):
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(
                prefix=".off-speaker-clock-", dir=output_path.parent
            ) as directory:
                return self.render_timeline(
                    output_path,
                    audio,
                    af_chain,
                    crossfade_curve=crossfade_curve,
                    requested_extent=requested_extent,
                    clock_path=Path(directory) / "clock.json",
                )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        leaves = sources(audio)
        n = len(leaves)
        source_paths = [leaf.path.resolve() for leaf in leaves]
        source_ranges: dict[Path, tuple[float, float]] = {}
        for path, seg in zip(source_paths, leaves, strict=True):
            start, end = source_ranges.get(path, (seg.src_start, seg.src_end))
            source_ranges[path] = (min(start, seg.src_start), max(end, seg.src_end))
        seeks = {
            path: MediaSeek.at(start, lead_sec=self.audio_start_sec(path))
            for path, (start, _end) in source_ranges.items()
        }
        filters: list[str] = []
        clock_names: list[str] = []
        bindings: dict[str, ClockBinding] = {}
        automatic_filters: list[tuple[int, OffSpeakerAudio, int]] = []
        root_indices: dict[str, int] = {}
        node_order = [node for node in postorder(audio) if not isinstance(node, MaskAudio)]
        source_node_indices = [
            i for i, node in enumerate(node_order) if isinstance(node, SourceAudio)
        ]

        def observer(name: str) -> str:
            if clock_path is None:
                return ""
            clock_names.append(name)
            return f",ashowinfo@restore_{name}"

        def bind(name: str, output_label: str) -> None:
            if clock_path is not None:
                bindings[name] = ClockBinding(
                    name, len(filters) - 1, output_label, name, len(filters) - 1, output_label
                )

        split_labels = [""] * n
        # A one-rate filter downstream (arnndn, loudnorm) makes FFmpeg resample each recording
        # before ``atrim``, but only while no delay pins the rate in between. Naming the
        # resample here puts every piece at that rate whether or not the graph has delays.
        forced = graph_rate(af_chain)
        resample = f"aresample={forced}" if forced else ""
        for input_index, path in enumerate(source_ranges):
            segment_indices = [i for i, p in enumerate(source_paths) if p == path]
            labels = [f"[src_in{input_index}_{i}]" for i in range(len(segment_indices))]
            if len(labels) > 1:
                head = f"{resample}," if resample else ""
                filters.append(f"[{input_index}:a]{head}asplit={len(labels)}{''.join(labels)}")
            else:
                filters.append(f"[{input_index}:a]{resample or 'anull'}{labels[0]}")
            for segment_index, label in zip(segment_indices, labels, strict=True):
                split_labels[segment_index] = label

        for i, seg in enumerate(leaves):
            seek = seeks[source_paths[i]]
            filters.append(
                f"{split_labels[i]}atrim=start={seek.offset(seg.src_start)}:"
                f"end={seek.offset(seg.src_end)},asetpts=PTS-STARTPTS{observer(f'trim_{i}')}[src{i}]"
            )
            bind(f"trim_{i}", f"[src{i}]")

        src_labels = [f"[src{i}]" for i in range(n)]
        fill_args = self._mix_fills(
            leaves,
            filters,
            src_labels,
            source_paths=source_paths,
            source_ranges=source_ranges,
        )

        seg_labels: list[str] = []
        source_rates: dict[Path, int] = {}
        for i, seg in enumerate(leaves):
            path = source_paths[i]
            seek = seeks[path]
            dur = seg.src_end - seg.src_start
            chain = self._fade_chain(dur, seg.fade_in_sec, seg.fade_out_sec)
            if seg.mute_spans:
                if path not in source_rates:
                    source_rates[path] = self.probe(path).sample_rate
                chain.extend(
                    self._mute_chain(
                        dur,
                        seg.mute_spans,
                        sample_rate=source_rates[path],
                        source_start=seg.src_start,
                        origin=seek.first_sample(seg.src_start, source_rates[path]),
                    )
                )
            body = ",".join(chain) if chain else "anull"
            filters.append(
                f"{src_labels[i]}{body}{observer(f'node_{source_node_indices[i]}')}[a{i}]"
            )
            bind(f"node_{source_node_indices[i]}", f"[a{i}]")
            root_indices[f"[a{i}]"] = source_node_indices[i]
            seg_labels.append(f"[a{i}]")

        leaf_labels = iter(seg_labels)
        node_labels: list[str] = []
        next_label = 0
        silence_probe: AudioProbe | None = None

        def emit(inputs: str, operation: str) -> str:
            nonlocal next_label
            label = f"[node{next_label}]"
            next_label += 1
            filters.append(f"{inputs}{operation}{label}")
            return label

        delays: list[tuple[int, str, float, str, str]] = []

        def compile_audio() -> str:
            nonlocal silence_probe
            node_index = 0
            for node in postorder(audio):
                match node:
                    case SourceAudio():
                        node_labels.append(next(leaf_labels))
                    case OffSpeakerAudio():
                        automatic_filters.append((len(filters), node, node_index))
                        node_labels.append(
                            emit(node_labels.pop(), "aeval=exprs='val(ch)*(1)':c=same")
                        )
                    case MaskAudio():
                        if (
                            node.clock is None
                            or node.first_source_frame is None
                            or node.source_rate is None
                        ):
                            raise clock_error()

                        selected = "+".join(
                            f"gte(n,{_mask_endpoint(start, node.source_rate, node.first_source_frame, node.source_transforms)})*lt(n,{_mask_endpoint(end, node.source_rate, node.first_source_frame, node.source_transforms)})"
                            for start, end in node.windows
                        )
                        context = format_filter(node.clock.producer)
                        consumer = format_filter(node.clock.consumer)
                        body_label = node_labels.pop()
                        body_index = root_indices[body_label]
                        mask_name = f"mask_{body_index}"
                        masked = emit(
                            body_label,
                            f"{context},aeval=exprs='val(ch)*(1-min(1,{selected}))':c=same,{context},{consumer}{observer(mask_name)}",
                        )
                        binding = bindings[f"node_{body_index}"]
                        bindings[binding.name] = ClockBinding(
                            binding.name,
                            binding.filter_index,
                            binding.output_label,
                            mask_name,
                            len(filters) - 1,
                            masked,
                        )
                        root_indices[masked] = body_index
                        node_labels.append(masked)
                    case SequenceAudio():
                        child_count = len(node.tail) + 1
                        labels = node_labels[-child_count:]
                        del node_labels[-child_count:]
                        node_labels.append(emit("".join(labels), f"concat=n={len(labels)}:v=0:a=1"))
                    case CrossfadeAudio():
                        right = node_labels.pop()
                        left = node_labels.pop()
                        node_labels.append(
                            emit(
                                left + right,
                                f"acrossfade=d={node.overlap_sec}:c1={crossfade_curve}:c2={crossfade_curve}",
                            )
                        )
                    case MixAudio():
                        ats = (node.head, *node.tail)
                        child_labels = node_labels[-len(ats) :]
                        del node_labels[-len(ats) :]
                        labels = []
                        for child_index, (at, label) in enumerate(
                            zip(ats, child_labels, strict=True)
                        ):
                            if at.start_sec > 0:
                                delay_name = f"delay_{node_index}_{child_index}"
                                inputs, observed = label, observer(delay_name)
                                label = emit(
                                    inputs,
                                    f"adelay@pin_{len(delays)}=1S:all=1,asetpts=N/SR/TB{observed}",
                                )
                                delays.append(
                                    (len(filters) - 1, inputs, at.start_sec, observed, label)
                                )
                                bind(delay_name, label)
                            labels.append(label)
                        if len(labels) == 1:
                            node_labels.append(labels[0])
                        else:
                            node_labels.append(
                                emit(
                                    "".join(labels),
                                    f"amix=inputs={len(labels)}:duration=longest:normalize=0,asetpts=N/SR/TB,"
                                    "asetnsamples=n=1024:p=0",
                                )
                            )
                    case SilenceAudio():
                        if silence_probe is None:
                            silence_probe = (
                                self.probe(source_paths[0])
                                if source_paths
                                else AudioProbe(
                                    0.0, 48000, 2, audio_start_sec=0.0, rebases_audio_reads=False
                                )
                            )
                        probe = silence_probe
                        layout = f"{probe.channels}c"
                        node_labels.append(
                            emit(
                                "",
                                f"anullsrc=r={probe.sample_rate}:cl={layout},"
                                f"atrim=end_sample={int(node.duration_sec * probe.sample_rate)}",
                            )
                        )
                if not isinstance(node, MaskAudio):
                    if not isinstance(node, SourceAudio) and clock_path is not None:
                        label = f"[clock_{node_index}]"
                        filters.append(
                            f"{node_labels.pop()}anull{observer(f'node_{node_index}')}{label}"
                        )
                        bind(f"node_{node_index}", label)
                        root_indices[label] = node_index
                        node_labels.append(label)
                    node_index += 1
            return node_labels[0]

        combined = compile_audio()
        final_chain = af_chain or "anull"
        if requested_extent is not None:
            seconds = requested_extent.seconds
            final_chain += f",apad=whole_dur={seconds},atrim=duration={seconds}"
        filters.append(f"{combined}{final_chain}{observer('output')}[out]")

        input_args: list[str] = []
        for path, (_start, end) in source_ranges.items():
            input_args.extend([*seeks[path].input_args(end), "-i", str(path)])
        input_args.extend(fill_args)
        input_paths = tuple(
            Path(input_args[i + 1]) for i, option in enumerate(input_args) if option == "-i"
        )

        def render_command(scratch: ExitStack | Path) -> list[str]:
            graph = ";".join(filters)
            file = graph_file(graph, scratch)
            graph_args = (
                ["-filter_complex", graph] if file is None else ["-/filter_complex", str(file)]
            )
            return [self.ffmpeg, "-y", *input_args, *graph_args, "-map", "[out]", str(output_path)]

        if delays:
            pinned = negotiated_rates(
                self.ffmpeg,
                self.ffprobe,
                filters,
                input_paths,
                [f"adelay@pin_{k}" for k in range(len(delays))],
            )
            for k, (index, inputs, start_sec, observed, label) in enumerate(delays):
                filters[index] = (
                    f"{inputs}{_delay_filter(start_sec, pinned[f'adelay@pin_{k}'])}{observed}{label}"
                )
        if clock_path is None:
            with ExitStack() as stack:
                spawn_or_too_long(run, render_command(stack), check=True, capture_output=True)
        else:
            clock_path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(
                prefix=".restore-clock-", dir=clock_path.parent
            ) as directory:
                raw_graph = Path(directory) / "graph.json"
                stderr_path = Path(directory) / "stderr.log"
                formats, consumers = configure_observers(
                    self.ffmpeg,
                    self.ffprobe,
                    filters,
                    input_paths,
                    bindings,
                    clock_names,
                )
                for filter_index, node, node_index in automatic_filters:
                    body_nodes = [
                        child for child in postorder(node.body) if not isinstance(child, MaskAudio)
                    ]
                    body_first = node_index - len(body_nodes)
                    primary_index = next(
                        body_first + i
                        for i, child in enumerate(body_nodes)
                        if child is node.primary
                    )
                    leaf_index = source_node_indices.index(primary_index)
                    if not (
                        node.body is node.primary
                        or (
                            isinstance(node.body, MixAudio)
                            and node.body.head.audio is node.primary
                            and node.body.head.start_sec == 0
                        )
                    ):
                        raise clock_error()
                    trim_rate = formats[f"trim_{leaf_index}"].sample_rate
                    origin = seeks[source_paths[leaf_index]].first_sample(
                        node.primary.src_start, trim_rate
                    )
                    path_names = [f"trim_{leaf_index}", f"node_{primary_index}"]
                    if node.body is not node.primary:
                        path_names.append(f"node_{node_index - 1}")
                    rates = [trim_rate]
                    for name in path_names:
                        rates.extend(
                            (formats[name].sample_rate, formats[consumers[name]].sample_rate)
                        )

                    mapping = SourceFrameMapping(
                        trim_rate,
                        origin,
                        tuple(FrameTransform(before, after) for before, after in pairwise(rates)),
                    )
                    gain = automatic_gain_expression(node.envelopes, mapping, node.bypass_windows)
                    filters[filter_index] = filters[filter_index].replace(
                        "val(ch)*(1)", f"val(ch)*({gain})"
                    )
                cmd = render_command(Path(directory))
                observed_cmd = [
                    cmd[0],
                    "-print_graphs_file",
                    str(raw_graph),
                    "-print_graphs_format",
                    "json",
                    *cmd[1:],
                ]
                with stderr_path.open("wb") as stderr:
                    result = spawn_or_too_long(run, observed_cmd, stdout=DEVNULL, stderr=stderr)
                if result.returncode:
                    with stderr_path.open("rb") as error_stream:
                        error_stream.seek(0, 2)
                        error_stream.seek(max(0, error_stream.tell() - PCM_STDERR_TAIL_BYTES))
                        raise CalledProcessError(
                            result.returncode, observed_cmd, stderr=error_stream.read()
                        )
                clock = observed_clock(
                    raw_graph,
                    stderr_path,
                    formats,
                    consumers,
                    tuple(seeks[path].source_seek_us for path in source_paths),
                    tuple(source_node_indices),
                    output_path,
                    audio,
                    partial=requested_extent is not None,
                )
                clock_path.write_text(json.dumps(asdict(clock)))
        return output_path

    def _mix_fills(
        self,
        leaves: list[SourceAudio],
        filters: list[str],
        src_labels: list[str],
        *,
        source_paths: list[Path],
        source_ranges: dict[Path, tuple[float, float]],
    ) -> list[str]:
        """Sum each segment's ``fill_path`` under it; returns the fill inputs' ffmpeg args.

        A fill input is a WAV on the audio-relative clock, so it is read through a lead-free
        ``MediaSeek`` over the same bounds and trimmed to the same range, and both land on
        the same samples. The sum is converted back to the media decoder's sample format, so
        where the fill is digital silence every later filter sees exactly the samples it would
        without the fill.
        """
        groups: dict[tuple[Path, Path], list[int]] = {}
        for i, seg in enumerate(leaves):
            if seg.fill_path is not None:
                groups.setdefault((seg.fill_path, source_paths[i]), []).append(i)
        first_input = len(source_ranges)
        args: list[str] = []
        formats: dict[Path, str | None] = {}
        for k, ((fill, media), indices) in enumerate(groups.items()):
            seek = MediaSeek.at(source_ranges[media][0], lead_sec=0.0)
            args.extend([*seek.input_args(source_ranges[media][1]), "-i", str(fill)])
            labels = [f"[fill_in{k}_{j}]" for j in range(len(indices))]
            splitter = f"asplit={len(labels)}" if len(labels) > 1 else "anull"
            filters.append(f"[{first_input + k}:a]{splitter}{''.join(labels)}")
            if media not in formats:
                formats[media] = self.probe(media).sample_fmt
            restore = f",aformat=sample_fmts={formats[media]}" if formats[media] else ""
            for i, label in zip(indices, labels, strict=True):
                seg = leaves[i]
                filters.append(
                    f"{label}atrim=start={seek.offset(seg.src_start)}:"
                    f"end={seek.offset(seg.src_end)},asetpts=PTS-STARTPTS[fill{i}]"
                )
                filters.append(
                    f"{src_labels[i]}[fill{i}]amix=inputs=2:normalize=0:duration=first"
                    f"{restore}[srcfill{i}]"
                )
                src_labels[i] = f"[srcfill{i}]"
        return args

    def join_audio_parts(
        self,
        part_paths: list[Path],
        output_path: Path,
        *,
        crossfade_ms_between: list[int] | None = None,
        crossfade_curve: str = "tri",
    ) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if not part_paths:
            raise CodedValueError(
                "no parts to join. Pass at least one part.", code="missing_argument"
            )
        if len(part_paths) == 1:
            shutil.copy2(part_paths[0], output_path)
            return output_path

        use_crossfade = (
            crossfade_ms_between is not None
            and len(crossfade_ms_between) == len(part_paths) - 1
            and any(ms > 0 for ms in crossfade_ms_between)
        )

        inputs: list[str] = []
        for p in part_paths:
            inputs.extend(["-i", str(p)])

        if use_crossfade:
            assert crossfade_ms_between is not None
            filters: list[str] = []
            prev_label = "[0:a]"
            for i in range(1, len(part_paths)):
                cf_sec = max(0.001, crossfade_ms_between[i - 1] / 1000.0)
                out_label = "[out]" if i == len(part_paths) - 1 else f"[x{i}]"
                filters.append(
                    f"{prev_label}[{i}:a]acrossfade=d={cf_sec}:c1={crossfade_curve}:c2={crossfade_curve}{out_label}"
                )
                prev_label = out_label
            filter_complex = ";".join(filters)
            cmd = [
                self.ffmpeg,
                "-y",
                *inputs,
                "-filter_complex",
                filter_complex,
                "-map",
                "[out]",
                str(output_path),
            ]
            run(cmd, check=True, capture_output=True)
            return output_path

        list_file = output_path.parent / f".concat_{output_path.stem}.txt"
        try:
            list_file.write_text(
                "\n".join(_concat_list_entry(p) for p in part_paths),
                encoding="utf-8",
            )
            cmd = [
                self.ffmpeg,
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(list_file),
                "-c",
                "copy",
                str(output_path),
            ]
            run(cmd, check=True, capture_output=True)
            return output_path
        finally:
            list_file.unlink(missing_ok=True)

    def concat_with_gap(
        self,
        wav_a: Path,
        wav_b: Path,
        out: Path,
        *,
        gap_sec: float,
        rate: int,
        channels: int,
    ) -> Path:
        silence = out.with_name(f".{out.stem}_gap.wav")
        try:
            run(
                [
                    self.ffmpeg,
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    f"anullsrc=r={rate}:cl={'mono' if channels <= 1 else 'stereo'}",
                    "-t",
                    f"{gap_sec:.6f}",
                    "-acodec",
                    "pcm_s16le",
                    str(silence),
                ],
                check=True,
                capture_output=True,
            )
            # Filter concat so mismatched layouts still join cleanly.
            cmd = [
                self.ffmpeg,
                "-y",
                "-i",
                str(wav_a),
                "-i",
                str(silence),
                "-i",
                str(wav_b),
                "-filter_complex",
                "[0:a][1:a][2:a]concat=n=3:v=0:a=1[out]",
                "-map",
                "[out]",
                "-acodec",
                "pcm_s16le",
                str(out),
            ]
            run(cmd, check=True, capture_output=True)
        finally:
            silence.unlink(missing_ok=True)
        return out

    def pad_end_silence(self, input_path: Path, output_path: Path, duration_sec: float) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        target = float(duration_sec)
        if target <= 0:
            raise CodedValueError(
                "duration_sec must be positive. Pass more than 0 seconds.", code="out_of_range"
            )
        cmd = [
            self.ffmpeg,
            "-y",
            "-i",
            str(input_path),
            "-af",
            f"apad=whole_dur={target}",
            "-t",
            f"{target}",
            str(output_path),
        ]
        run(cmd, check=True, capture_output=True)
        return output_path

    def apply_gain(self, input_path: Path, output_path: Path, gain_db: float) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            self.ffmpeg,
            "-y",
            "-i",
            str(input_path),
            "-af",
            f"volume={gain_db}dB",
            str(output_path),
        ]
        run(cmd, check=True, capture_output=True)
        return output_path

    @staticmethod
    def _sum_graph(
        track_wavs: list[tuple[Path, float]],
        tail: str | None,
        span: tuple[float, float | None] = (0.0, None),
    ) -> list[str]:
        """ffmpeg input + filtergraph args: each input at its gain, summed at unity (amix
        normalize=0, not 1/N), then ``tail`` (e.g. a trim or ebur128), ending at ``[out]``.

        ``span`` is the ``(start, end)`` seconds of every input to read; ``end`` None is EOF.
        """
        start, end = span
        seek = MediaSeek.at(start, lead_sec=0.0)
        trim = f"atrim=start={seek.offset(start)},asetpts=PTS-STARTPTS," if start else ""
        inputs: list[str] = []
        filters: list[str] = []
        n = len(track_wavs)
        suffix = f",{tail}" if tail else ""
        for i, (wav, gain_db) in enumerate(track_wavs):
            inputs.extend([*seek.input_args(end), "-i", str(wav)])
            label = f"{suffix}[out]" if n == 1 else f"[a{i}]"
            filters.append(f"[{i}:a]{trim}volume={gain_db}dB{label}")
        if n > 1:
            mix_inputs = "".join(f"[a{i}]" for i in range(n))
            filters.append(f"{mix_inputs}amix=inputs={n}:duration=longest:normalize=0{suffix}[out]")
        return [*inputs, "-filter_complex", ";".join(filters), "-map", "[out]"]

    def _sum_tracks(
        self, track_wavs: list[tuple[Path, float]], output_path: Path, *, trim_db: float = 0.0
    ) -> None:
        tail = f"volume={trim_db}dB" if trim_db else None
        cmd = [self.ffmpeg, "-y", *self._sum_graph(track_wavs, tail), str(output_path)]
        run(cmd, check=True, capture_output=True)

    def _sum_true_peak_db(
        self, track_wavs: list[tuple[Path, float]], span: tuple[float, float | None]
    ) -> float | None:
        """True peak (dBTP) of the unity sum over ``span``, measured on the float graph."""
        cmd = [
            self.ffmpeg,
            "-hide_banner",
            "-nostats",
            *self._sum_graph(track_wavs, "ebur128=peak=true", span),
            "-f",
            "null",
            "-",
        ]
        r = run(cmd, check=True, capture_output=True, text=True)
        # FFmpeg may emit an empty summary while initializing the graph.
        peaks = _SUMMARY_TRUE_PEAK_RE.findall(r.stderr or "")
        return float(peaks[-1]) if peaks else None

    def silence(
        self, output_path: Path, duration_sec: float, *, sample_rate: int = 48000, channels: int = 2
    ) -> Path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        run(
            [
                self.ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                f"anullsrc=r={sample_rate}:cl={channels}c",
                "-t",
                str(duration_sec),
                "-c:a",
                "pcm_s16le",
                str(output_path),
            ],
            check=True,
        )
        return output_path

    def mix_tracks(
        self,
        track_wavs: list[tuple[Path, float]],
        output_path: Path,
        *,
        peak_ceiling_db: float | None = None,
        trim_db: float | None = None,
    ) -> Path:
        """Sum tracks at unity after each one's gain (never 1/N).

        With ``peak_ceiling_db``, trim the whole mix by ``peak_trim_db`` so it peaks at or
        below the ceiling (never up); no intermediate file. With ``trim_db``, sum at that
        trim instead: a window of a longer mix plays at the trim measured over all of it.
        """
        if peak_ceiling_db is not None and trim_db is not None:
            raise CodedValueError(
                "pass peak_ceiling_db or trim_db, not both", code="invalid_arguments"
            )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if not track_wavs:
            raise CodedValueError(
                "no tracks to mix. Pass at least one track.", code="missing_argument"
            )
        if peak_ceiling_db is not None:
            trim_db = self.peak_trim_db(track_wavs, float(peak_ceiling_db))
        if trim_db is None:
            if len(track_wavs) == 1:
                wav, gain_db = track_wavs[0]
                if float(gain_db) == 0.0:
                    shutil.copy2(wav, output_path)
                    return output_path
                return self.apply_gain(wav, output_path, float(gain_db))
            self._sum_tracks(track_wavs, output_path)
            return output_path
        self._sum_tracks(track_wavs, output_path, trim_db=trim_db)
        return output_path

    def peak_trim_db(self, track_wavs: list[tuple[Path, float]], ceiling_db: float) -> float:
        """Gain (<= 0 dB) that brings the unity sum's true peak down to ``ceiling_db``.

        Measures the true peak on the float graph (ebur128 to a null output), one span per
        worker in parallel. The spans meet in quiet blocks (``mix_spans.quiet_spans``), so
        their loudest peak is the single-pass peak.
        """
        spans = quiet_spans(track_wavs, ceiling_db)
        peaks = run_parallel(spans, lambda span: self._sum_true_peak_db(track_wavs, span))
        peak = None if None in peaks else max(p for p in peaks if p is not None)
        if peak is None:
            log.warning(
                "mix true peak not measured; mixing untrimmed (ceiling %s dBTP)", ceiling_db
            )
        trim = headroom_trim_db(peak, ceiling_db)
        if trim < 0:
            log.info("mix peaks at %s dBTP; trimmed %s dB to %s dBTP", peak, trim, ceiling_db)
        return trim

    def loudnorm_input_stats(
        self,
        input_path: Path,
        *,
        on_progress: Callable[[float, float], None] | None = None,
        total_sec: float | None = None,
    ) -> dict[str, float] | None:
        """loudnorm pass-1 values from one ebur128 pass.

        Much faster than a loudnorm measure pass, which resamples to 192 kHz.
        ``target_offset`` is 0: loudnorm only uses it in dynamic mode.
        """
        m = (
            self.measure_loudness_full(input_path, on_progress=on_progress, total_sec=total_sec)
            or {}
        )
        keys = {
            "input_i": "integrated_lufs",
            "input_tp": "true_peak_db",
            "input_lra": "lra",
            "input_thresh": "integrated_threshold_lufs",
        }
        stats: dict[str, float] = {}
        missing: list[str] = []
        for out_key, src_key in keys.items():
            value = m.get(src_key)
            if value is None:
                missing.append(src_key)
            else:
                stats[out_key] = value
        if missing:
            log.warning(
                "loudnorm pass-1 stats unavailable for %s (ebur128 summary has no %s); "
                "mastering runs single-pass loudnorm",
                input_path,
                ", ".join(missing),
            )
            return None
        stats["target_offset"] = 0.0
        return stats

    def measure_loudness_full(
        self,
        path: Path,
        *,
        on_progress: Callable[[float, float], None] | None = None,
        total_sec: float | None = None,
    ) -> dict[str, float | None] | None:
        """Integrated LUFS + true peak + LRA from ebur128 (for post-master QC).

        ``total_sec`` overrides the probed duration for progress (callers that
        already probed).
        """
        cmd = [
            self.ffmpeg,
            "-i",
            str(path),
            "-vn",
            "-af",
            "ebur128=framelog=verbose:peak=true,astats=metadata=1",
            "-f",
            "null",
            "-",
        ]
        if on_progress is None:
            r = run(cmd, capture_output=True)
            if r.returncode != 0:
                return None
            text = r.stderr
        else:
            duration = total_sec if total_sec is not None else self.probe(path).duration_sec
            callback_failed = False

            def report(done: float, total: float) -> None:
                nonlocal callback_failed
                try:
                    on_progress(done, total)
                except CalledProcessError:
                    callback_failed = True
                    raise

            try:
                text = self._run_with_progress(
                    cmd, total_sec=duration, on_progress=report, check=True
                )
            except CalledProcessError:
                if callback_failed:
                    raise
                return None
        text = ebur128_summary_text(text)
        if decoded_no_frames(text):
            return None
        i_m = re.search(r"\bI:\s*(-?\d+\.?\d*)\s*LUFS", text)
        tp_m = re.search(r"Peak:\s*(-?\d+\.?\d*)\s*dBFS", text)
        lra_m = re.search(r"\bLRA:\s*(-?\d+\.?\d*)\s*LU", text)
        thr_m = re.search(r"\bI:\s*-?\d+\.?\d*\s*LUFS\s+Threshold:\s*(-?\d+\.?\d*)\s*LUFS", text)
        if i_m is None:
            return None
        return {
            "integrated_lufs": float(i_m.group(1)),
            "true_peak_db": float(tp_m.group(1)) if tp_m else None,
            "lra": float(lra_m.group(1)) if lra_m else None,
            "integrated_threshold_lufs": float(thr_m.group(1)) if thr_m else None,
        }

    def measure_loudness_screen(self, path: Path) -> dict[str, float] | None:
        """Integrated LUFS and sample peak from ebur128, without its oversampled true peak.

        The integrated figure is the one ``measure_loudness_full`` reports; the sample
        peak does not exceed the true peak on any signal tried (the limiter loop adds
        ``SCREEN_PEAK_SLACK_DB`` of slack), so it bounds true-peak headroom from above.
        The one exception is a loudest sample in the last few samples of the file, which
        ffmpeg's true-peak pass omits.
        About a sixth of the cost of ``measure_loudness_full``.
        """
        r = run(
            [
                self.ffmpeg,
                "-i",
                str(path),
                "-vn",
                "-af",
                "ebur128=framelog=verbose:peak=sample",
                "-f",
                "null",
                "-",
            ],
            capture_output=True,
        )
        if r.returncode != 0:
            return None
        text = ebur128_summary_text(r.stderr)
        if decoded_no_frames(text):
            return None
        i_m = re.search(r"\bI:\s*(-?\d+\.?\d*)\s*LUFS", text)
        peak_m = re.search(r"Peak:\s*(-?\d+\.?\d*)\s*dBFS", text)
        if i_m is None or peak_m is None:
            return None
        return {"integrated_lufs": float(i_m.group(1)), "sample_peak_db": float(peak_m.group(1))}

    def _run_with_progress(
        self,
        argv: list[str],
        *,
        total_sec: float,
        on_progress: Callable[[float, float], None],
        check: bool = True,
    ) -> str:
        """Run ffmpeg with ``-progress pipe:1``, report (done_sec, total_sec), return stderr."""
        cmd = [argv[0], "-nostats", "-progress", "pipe:1", *argv[1:]]
        with tempfile.TemporaryFile() as err, popen(cmd, stdout=PIPE, stderr=err) as proc:
            try:
                if proc.stdout is None:
                    raise RuntimeError("ffmpeg progress pipe missing")
                for raw in proc.stdout:
                    done = _progress_seconds(raw.decode("utf-8", "replace"))
                    if done is not None:
                        on_progress(min(done, total_sec), total_sec)
                rc = proc.wait()
            except BaseException:
                proc.kill()
                proc.wait()
                raise
            err.seek(0)
            text = err.read().decode("utf-8", "replace")
        if check and rc != 0:
            raise CalledProcessError(rc, cmd, stderr=text)
        return text

    def master_loudness(
        self,
        input_path: Path,
        output_path: Path,
        integrated_lufs: float = -16.0,
        true_peak_db: float = -1.5,
        lra: float = 11.0,
        *,
        sample_rate: int | None = None,
        channels: int | None = None,
        on_progress: Callable[[float, float], None] | None = None,
        on_measure_progress: Callable[[float, float], None] | None = None,
    ) -> MasterResult:
        """Master to ``integrated_lufs`` under ``true_peak_db``, at the delivery rate.

        Pass 1 is ebur128 (I, TP, LRA, gate threshold), and ``plan_master`` picks
        the plan from it. The loudnorm plan is pass 2: loudnorm in linear mode with
        those values. loudnorm still falls back to dynamic mode when ``LRA > lra``
        (or the measured LRA is 0); ``normalization_type`` says which ran. The
        limiter plan, for a gain that would push peaks over the ceiling, runs
        ``_limit_to_target``. FFmpeg's loudnorm upsamples to 192 kHz for true-peak
        work; without an explicit ``-ar``/``-ac`` that rate would leak into
        mastered/export WAVs.

        ``on_measure_progress`` reports pass 1 (ebur128) and ``on_progress`` each
        render, as (done_sec, total_sec) of the input. Both use the one input
        probe, so they share a per-pass total.
        """
        output_path.parent.mkdir(parents=True, exist_ok=True)
        probe = self.probe(input_path)
        out_rate = sample_rate if sample_rate is not None else probe.sample_rate
        out_ch = channels if channels is not None else probe.channels
        delivery = ("-ar", str(out_rate), "-ac", str(out_ch))
        stats = self.loudnorm_input_stats(
            input_path, on_progress=on_measure_progress, total_sec=probe.duration_sec
        )
        plan = plan_master(
            stats,
            integrated_lufs=integrated_lufs,
            true_peak_db=true_peak_db,
            duration_sec=probe.duration_sec,
        )
        render = functools.partial(
            self._render_af, total_sec=probe.duration_sec, on_progress=on_progress
        )
        if isinstance(plan, LimiterPlan) and stats is not None:
            limiter = self._limit_to_target(
                input_path,
                output_path,
                plan,
                stats,
                integrated_lufs=integrated_lufs,
                true_peak_db=true_peak_db,
                sample_rate=out_rate,
                delivery=delivery,
                render=render,
            )
            return MasterResult(output_path, plan, stats, None, limiter)
        base = f"loudnorm=I={integrated_lufs}:TP={true_peak_db}:LRA={lra}"
        if stats is None or (isinstance(plan, LoudnormPlan) and not plan.two_pass):
            af = f"{base}:print_format=json"
        else:
            af = (
                f"{base}:measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
                f"measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:"
                f"offset={stats['target_offset']}:linear=true:print_format=json"
            )
        report = _loudnorm_json(render(input_path, output_path, af, *delivery)) or {}
        norm = report.get("normalization_type")
        return MasterResult(output_path, plan, stats, str(norm) if norm else None, None)

    def _limit_to_target(
        self,
        input_path: Path,
        output_path: Path,
        plan: LimiterPlan,
        stats: dict[str, float],
        *,
        integrated_lufs: float,
        true_peak_db: float,
        sample_rate: int,
        delivery: tuple[str, ...],
        render: Callable[..., str],
    ) -> LimiterReport:
        """Gain into an oversampled limiter under the ceiling, then trim onto the target.

        Limiting lowers the integrated loudness. The trim after the limiter can make
        up at most the true-peak headroom left under ``true_peak_db``; a larger
        shortfall is added to the gain into the limiter, and the limiter runs again.
        """
        limit_db = round(true_peak_db - LIMITER_MARGIN_DB, 2)
        drive_db = plan.gain_db
        renders = 0
        with tempfile.TemporaryDirectory(dir=output_path.parent) as tmp:
            limited = Path(tmp) / "limited.wav"
            while True:
                renders += 1
                af = limiter_af(drive_db, limit_db, sample_rate)
                render(input_path, limited, af, "-c:a", "pcm_f32le")
                if renders < LIMITER_MAX_RENDERS:
                    screen = self.measure_loudness_screen(limited)
                    if screen is not None:
                        screen_shortfall = round(integrated_lufs - screen["integrated_lufs"], 2)
                        screen_headroom = round(
                            true_peak_db - screen["sample_peak_db"] - TRUE_PEAK_PRINT_ROUNDING_DB,
                            2,
                        )
                        if screen_shortfall > screen_headroom + SCREEN_PEAK_SLACK_DB:
                            drive_db = round(drive_db + screen_shortfall, 2)
                            continue
                level = self.measure_loudness_full(limited) or {}
                lufs, peak = level.get("integrated_lufs"), level.get("true_peak_db")
                if lufs is None or peak is None:
                    raise RuntimeError(f"ebur128 could not measure the limited master {limited}")
                shortfall = round(integrated_lufs - lufs, 2)
                headroom = round(true_peak_db - peak - TRUE_PEAK_PRINT_ROUNDING_DB, 2)
                converged = shortfall <= headroom
                if converged or renders == LIMITER_MAX_RENDERS:
                    break
                drive_db = round(drive_db + shortfall, 2)
            trim_db = min(shortfall, headroom)
            render(limited, output_path, f"volume={trim_db}dB", *delivery)
        return LimiterReport(
            gain_db=plan.gain_db,
            drive_db=drive_db,
            limit_db=limit_db,
            renders=renders,
            converged=converged,
            trim_db=trim_db,
            peak_reduction_db=round(stats["input_tp"] + drive_db - peak, 2),
            loudness_reduction_lu=round(stats["input_i"] + drive_db - lufs, 2),
        )

    def _render_af(
        self,
        input_path: Path,
        output_path: Path,
        af: str,
        *out_args: str,
        total_sec: float,
        on_progress: Callable[[float, float], None] | None,
    ) -> str:
        """Run ``ffmpeg -i input -af af *out_args output`` and return its stderr."""
        cmd = [self.ffmpeg, "-y", "-i", str(input_path), "-af", af, *out_args, str(output_path)]
        if on_progress is None:
            return run(cmd, check=True, capture_output=True, text=True).stderr or ""
        return self._run_with_progress(cmd, total_sec=total_sec, on_progress=on_progress)

    def filter_audio(
        self,
        input_path: Path,
        output_path: Path,
        af: str,
        *,
        sample_rate: int | None = None,
        channels: int | None = None,
    ) -> Path:
        """Apply an FFmpeg audio filter graph, preserving rate/channels by default."""
        output_path.parent.mkdir(parents=True, exist_ok=True)
        probe = self.probe(input_path)
        out_rate = sample_rate if sample_rate is not None else probe.sample_rate
        out_ch = channels if channels is not None else probe.channels
        cmd = [
            self.ffmpeg,
            "-y",
            "-i",
            str(input_path),
            "-af",
            af,
            "-ar",
            str(out_rate),
            "-ac",
            str(out_ch),
            str(output_path),
        ]
        run(cmd, check=True, capture_output=True)
        return output_path

    def export_audio(
        self,
        wav_path: Path,
        output_path: Path,
        *,
        codec: str | None = None,
        format: str | None = None,
        bitrate_kbps: int | None = None,
        sample_rate: int | None = None,
        channels: int | None = None,
        metadata: dict[str, str] | None = None,
        extra_args: list[str] | None = None,
        cancel_check: Callable[[], bool] | None = None,
    ) -> Path:
        """Encode ``wav_path`` to ``output_path``.

        ``cancel_check`` returning true stops ffmpeg and raises ``CancelledProgress``;
        ``output_path`` may then hold a partial file, so callers render to a temp.
        """
        output_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [self.ffmpeg, "-y", "-i", str(wav_path)]
        if format:
            cmd.extend(["-f", format])
        if codec:
            cmd.extend(["-codec:a", codec])
        if bitrate_kbps is not None:
            cmd.extend(["-b:a", f"{bitrate_kbps}k"])
        if sample_rate is not None:
            cmd.extend(["-ar", str(sample_rate)])
        if channels is not None:
            cmd.extend(["-ac", str(channels)])
        for key, value in (metadata or {}).items():
            cmd.extend(["-metadata", f"{key}={value}"])
        if extra_args:
            cmd.extend(extra_args)
        cmd.append(str(output_path))
        if cancel_check is None:
            spawn_or_too_long(run, cmd, check=True, capture_output=True)
        else:
            _run_cancellable(cmd, cancel_check)
        return output_path

    def export_mp3(
        self,
        wav_path: Path,
        mp3_path: Path,
        bitrate_kbps: int = 128,
        metadata: dict[str, str] | None = None,
    ) -> Path:
        return self.export_audio(
            wav_path,
            mp3_path,
            codec="libmp3lame",
            bitrate_kbps=bitrate_kbps,
            metadata=metadata,
        )

    def measure_loudness_blocks(
        self, path: Path, af: str | None = None
    ) -> list[tuple[float, float]]:
        """(t, momentary LUFS) every 100 ms from ebur128, after the optional filter chain ``af``."""
        chain = (
            "ebur128=framelog=info" if not af or af == "anull" else f"{af},ebur128=framelog=info"
        )
        cmd = [
            self.ffmpeg,
            "-hide_banner",
            "-nostats",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-af",
            chain,
            "-f",
            "null",
            "-",
        ]
        r = run(cmd, capture_output=True)
        stderr = _stderr_text(r.stderr)
        if r.returncode != 0:
            log.warning(
                "ebur128 measure failed for %s (exit %s): %s",
                path,
                r.returncode,
                stderr[-PCM_STDERR_TAIL_BYTES:].strip(),
            )
            return []
        blocks = [
            (float(t), float(m))
            for t, m in _EBUR128_BLOCK_RE.findall(filter_log_text(stderr, "ebur128"))
        ]
        if not blocks:
            log.warning(
                "ebur128 printed no momentary blocks for %s; its log format may have changed", path
            )
        return blocks

    def measure_loudness(self, path: Path) -> float | None:
        cmd = [
            self.ffmpeg,
            "-i",
            str(path),
            "-map",
            "0:a:0",
            "-af",
            "ebur128=framelog=verbose",
            "-f",
            "null",
            "-",
        ]
        r = run(cmd, capture_output=True)
        if r.returncode != 0:
            return None
        text = ebur128_summary_text(r.stderr)
        if decoded_no_frames(text):
            return None
        m = re.search(r"I:\s*(-?\d+\.?\d*)\s*LUFS", text)
        if m:
            return float(m.group(1))
        m = re.search(r"Integrated loudness:\s*(-?\d+\.?\d*)", text)
        if m:
            return float(m.group(1))
        return None

    def render_dialogue_track(
        self,
        project: EpisodeProject,
        track: Track,
        output_path: Path,
        defaults: dict,
    ) -> Path:
        from podcast_mcp.engines.timeline_render import render_track_from_timeline

        return render_track_from_timeline(project, track, output_path, defaults, engine=self)

    def extract_segment(
        self,
        src: Path,
        output_path: Path,
        start_sec: float,
        end_sec: float,
        *,
        mute_spans: tuple[MuteEnvelope, ...] = (),
    ) -> Path:
        """Extract [start_sec, end_sec] from src into output_path (non-destructive).

        ``mute_spans`` are seconds from the start of the extracted window (same
        clock as ``mute_spans_for_source_window``).
        """
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if mute_spans:
            # Same atrim + asetpts + volume graph as render_timeline so `t` in
            # the mute expression matches output samples (plain -ss/-af does not).
            return self.render_timeline(
                output_path,
                SourceAudio(src, max(0.0, start_sec), end_sec, mute_spans=mute_spans),
                "anull",
            )
        seek = MediaSeek.at(max(0.0, start_sec), lead_sec=self.audio_start_sec(src))
        cmd = [
            self.ffmpeg,
            "-y",
            "-threads",
            "1",
            *seek.input_args(),
            "-i",
            str(src),
            "-map",
            "0:a:0",
            "-threads",
            "1",
            *seek.output_args(max(0.01, end_sec - start_sec)),
            "-acodec",
            "pcm_s16le",
            str(output_path),
        ]
        run(cmd, check=True, capture_output=True)
        return output_path

    def generate_tone(
        self,
        dest: Path,
        *,
        duration_sec: float,
        freq_hz: float = 220.0,
        sample_rate: int = 48000,
        gain_db: float = 0.0,
    ) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            self.ffmpeg,
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={freq_hz}:duration={duration_sec}",
            "-ar",
            str(sample_rate),
            "-ac",
            "1",
        ]
        if gain_db != 0.0:
            cmd.extend(["-af", f"volume={gain_db}dB"])
        cmd.append(str(dest))
        run(cmd, check=True, capture_output=True)
        return dest

    def render_spectrogram(
        self,
        input_path: Path,
        output_png: Path,
        *,
        start_sec: float | None = None,
        duration_sec: float | None = None,
        size: str = "1200x600",
        scale: str = "log",
        legend: bool = True,
    ) -> Path:
        """Render a spectrogram PNG (hum, sibilance, room resonance, clipping are visible here).

        ``legend=False`` keeps the x-axis linear across the full image (needed when
        grounding JSON events to pixel x).
        """
        output_png.parent.mkdir(parents=True, exist_ok=True)
        inp = input_path
        tmp: Path | None = None
        if start_sec is not None and duration_sec is not None:
            tmp = output_png.with_suffix(".segment.wav")
            self.extract_segment(inp, tmp, start_sec, start_sec + duration_sec)
            inp = tmp
        legend_flag = "1" if legend else "0"
        cmd = [
            self.ffmpeg,
            "-y",
            *_VISUAL_DIAGNOSTIC_THREAD_ARGS,
            "-i",
            str(inp),
            "-lavfi",
            f"showspectrumpic=s={size}:scale={scale}:legend={legend_flag}",
            str(output_png),
        ]
        run(cmd, check=True, capture_output=True)
        if tmp is not None:
            tmp.unlink(missing_ok=True)
        return output_png

    def render_showwavespic(
        self,
        input_path: Path,
        output_png: Path,
        *,
        start_sec: float | None = None,
        duration_sec: float | None = None,
        size: str = "1200x200",
        colors: str = "0x4a9eff",
    ) -> Path:
        """Render a waveform PNG for an audio file or segment."""
        output_png.parent.mkdir(parents=True, exist_ok=True)
        inp = input_path
        tmp: Path | None = None
        if start_sec is not None and duration_sec is not None:
            tmp = output_png.with_suffix(".segment.wav")
            self.extract_segment(inp, tmp, start_sec, start_sec + duration_sec)
            inp = tmp
        cmd = [
            self.ffmpeg,
            "-y",
            *_VISUAL_DIAGNOSTIC_THREAD_ARGS,
            "-i",
            str(inp),
            "-filter_complex",
            f"showwavespic=s={size}:colors={colors}",
            "-frames:v",
            "1",
            str(output_png),
        ]
        run(cmd, check=True, capture_output=True)
        if tmp is not None:
            tmp.unlink(missing_ok=True)
        return output_png

    def render_stacked_showwavespic(
        self,
        input_paths: list[Path],
        output_png: Path,
        *,
        size: str = "1200x180",
        colors: list[str] | None = None,
    ) -> Path:
        """Stack showwavespic renders vertically (one row per input)."""
        if not input_paths:
            raise CodedValueError(
                "no inputs for stacked waveform. Pass at least one input.", code="missing_argument"
            )
        output_png.parent.mkdir(parents=True, exist_ok=True)
        palette = colors or ["0x4a9eff", "0xe67e22", "0x2ecc71", "0x9b59b6"]
        parts: list[str] = []
        for i, _path in enumerate(input_paths):
            color = palette[i % len(palette)]
            parts.append(f"[{i}:a]showwavespic=s={size}:colors={color}[w{i}]")
        labels = "".join(f"[w{i}]" for i in range(len(input_paths)))
        parts.append(f"{labels}vstack=inputs={len(input_paths)}[out]")
        fc = ";".join(parts)
        cmd = [self.ffmpeg, "-y", *_VISUAL_DIAGNOSTIC_THREAD_ARGS]
        for p in input_paths:
            cmd.extend(["-i", str(p)])
        cmd.extend(
            [
                "-filter_complex",
                fc,
                "-map",
                "[out]",
                "-frames:v",
                "1",
                str(output_png),
            ]
        )
        run(cmd, check=True, capture_output=True)
        return output_png

    def _listed_names(self, flag: str) -> set[str] | None:
        """Names from ``ffmpeg -hide_banner <flag>`` (``-filters``, ``-encoders``, ``-muxers``).

        None when the listing could not be read; only a successful read is cached.
        """
        cached = self._listed_names_cache.get(flag)
        if cached is not None:
            return cached
        try:
            r = run(
                [self.ffmpeg, "-hide_banner", flag],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (OSError, TimeoutExpired):
            return None
        if r.returncode != 0:
            return None
        names: set[str] = set()
        for line in (r.stdout or "").splitlines():
            parts = line.split()
            if len(parts) >= 2:
                names.add(parts[1])
        self._listed_names_cache[flag] = names
        return names

    def supports_encode(self, codec: str, muxer: str) -> bool | None:
        encoders = self._listed_names("-encoders")
        muxers = self._listed_names("-muxers")
        if encoders is None or muxers is None:
            return None
        return codec in encoders and muxer in muxers

    def _has_filter(self, name: str) -> bool:
        names = self._listed_names("-filters")
        if names is None:
            names = self._listed_names_cache["-filters"] = set()
        return name in names

    def annotate_time_marks(
        self,
        png_path: Path,
        marks: list[dict[str, Any]],
        out_path: Path,
        *,
        window_start: float | None = None,
        window_end: float | None = None,
        plot_width: int = 1200,
    ) -> Path:
        """Burn vertical time marks onto a spectrogram/waveform PNG.

        ``marks`` items: ``{x: 0-1, label: str, kind: str}``. x is relative to the
        plot width (legend=0 images). Uses drawbox always; drawtext labels only
        when this ffmpeg build includes the filter (Homebrew often omits
        libfreetype). No Pillow.
        """
        if not png_path.is_file():
            raise FileNotFoundError(f"png not found: {png_path}")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        font = _drawtext_font()
        use_drawtext = bool(font is not None and self._has_filter("drawtext"))
        vf = _annotate_vf(
            marks,
            plot_width=plot_width,
            window_start=window_start,
            window_end=window_end,
            font=font,
            use_drawtext=use_drawtext,
        )
        if not vf:
            if png_path.resolve() != out_path.resolve():
                shutil.copy2(png_path, out_path)
            return out_path
        if self._overlay_png(png_path, out_path, vf):
            return out_path
        if use_drawtext:
            boxes_only = _annotate_vf(
                marks,
                plot_width=plot_width,
                window_start=window_start,
                window_end=window_end,
                font=font,
                use_drawtext=False,
            )
            if boxes_only and self._overlay_png(png_path, out_path, boxes_only):
                return out_path
        if png_path.resolve() != out_path.resolve():
            shutil.copy2(png_path, out_path)
        return out_path

    def _overlay_png(self, png_path: Path, out_path: Path, vf: str) -> bool:
        with tempfile.TemporaryDirectory(
            prefix=f".{out_path.stem}.", dir=out_path.parent
        ) as temporary_dir:
            tmp = Path(temporary_dir) / f"{out_path.stem}.annot.png"
            cmd = [
                self.ffmpeg,
                "-y",
                "-i",
                str(png_path),
                "-vf",
                vf,
                str(tmp),
            ]
            try:
                run(cmd, check=True, capture_output=True)
                publish_completed_file(tmp, out_path)
                return True
            except CalledProcessError:
                return False
