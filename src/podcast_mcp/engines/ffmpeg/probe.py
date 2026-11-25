from __future__ import annotations

import functools
import json
import math
import threading
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from podcast_mcp.engines.ffmpeg import runtime
from podcast_mcp.engines.ffmpeg.runtime import _UNTRUSTED_PROTOCOLS
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.process import DEVNULL, PIPE, is_in_process_media_tool
from podcast_mcp.util.project_state import FileRevision, file_revision

if TYPE_CHECKING:
    from podcast_mcp.engines.ffmpeg.host import FFmpegSelf

_PACKET_SCAN_TIMEOUT_SEC = 120.0
MAX_PROBED_AUDIO_EXTENT_SEC = 7 * 24 * 3600.0
_PACKET_RECORD_BYTES = 4096
# Audio starting this much after the container start is a leading gap, not codec priming.
_AUDIO_START_GAP_SEC = 0.02


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
    proc = runtime.popen(cmd, stdout=PIPE, stderr=DEVNULL)
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


class ProbeMixin:
    def audio_start_sec(self: FFmpegSelf, path: Path) -> float:
        """How far ``path``'s first audio sample sits past its container start."""
        from podcast_mcp.engines.media_probe import audio_start_sec

        return audio_start_sec(path)

    def probe(self: FFmpegSelf, path: Path, *, untrusted: bool = False) -> AudioProbe:
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
        r = runtime.run(
            cmd, capture_output=True, text=True, check=True, timeout=_PACKET_SCAN_TIMEOUT_SEC
        )
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

    def _first_decoded_pts(self: FFmpegSelf, path: Path, *, untrusted: bool) -> float | None:
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
        r = runtime.run(cmd, capture_output=True, text=True, timeout=_PACKET_SCAN_TIMEOUT_SEC)
        lines = r.stdout.split() if r.returncode == 0 else []
        return _seconds(lines[0].rstrip(",")) if lines else None

    def _scan_audio_extent(
        self: FFmpegSelf, path: Path, *, untrusted: bool
    ) -> tuple[float, float] | None:
        """a:0's first packet pts and the end of its last packet, or None when the scan fails."""
        try:
            resolved = path.resolve()
            if is_in_process_media_tool(self.ffprobe):
                # No file identifies the installed backend, so its answer is never cached.
                return _read_audio_extent(self.ffprobe, str(resolved), untrusted=untrusted)
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
