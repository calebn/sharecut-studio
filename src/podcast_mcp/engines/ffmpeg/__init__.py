from __future__ import annotations

import re
import tempfile
import threading
from collections.abc import Callable, Iterable, Iterator
from contextlib import suppress
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from podcast_mcp.engines.ffmpeg import runtime
from podcast_mcp.engines.ffmpeg.decode import (
    PCM_STREAM_CHUNK_FRAMES as PCM_STREAM_CHUNK_FRAMES,
)
from podcast_mcp.engines.ffmpeg.decode import (
    PCM_STREAM_TIMEOUT_SEC as PCM_STREAM_TIMEOUT_SEC,
)
from podcast_mcp.engines.ffmpeg.decode import (
    PCM_WINDOW_TIMEOUT_SEC as PCM_WINDOW_TIMEOUT_SEC,
)
from podcast_mcp.engines.ffmpeg.decode import DecodeMixin
from podcast_mcp.engines.ffmpeg.diagnostics import DiagnosticsMixin
from podcast_mcp.engines.ffmpeg.encode import EncodeMixin
from podcast_mcp.engines.ffmpeg.filter_log import decoded_no_frames, filter_log_text
from podcast_mcp.engines.ffmpeg.loudness import LoudnessMixin
from podcast_mcp.engines.ffmpeg.mix import MixMixin
from podcast_mcp.engines.ffmpeg.mix import (
    headroom_trim_db as headroom_trim_db,
)
from podcast_mcp.engines.ffmpeg.mix import (
    logged_headroom_trim_db as logged_headroom_trim_db,
)
from podcast_mcp.engines.ffmpeg.probe import (
    LATE_MPEG_AUDIO_MESSAGE as LATE_MPEG_AUDIO_MESSAGE,
)
from podcast_mcp.engines.ffmpeg.probe import (
    MAX_PROBED_AUDIO_EXTENT_SEC as MAX_PROBED_AUDIO_EXTENT_SEC,
)
from podcast_mcp.engines.ffmpeg.probe import (
    AudioProbe as AudioProbe,
)
from podcast_mcp.engines.ffmpeg.probe import (
    LateMpegAudioError as LateMpegAudioError,
)
from podcast_mcp.engines.ffmpeg.probe import ProbeMixin
from podcast_mcp.engines.ffmpeg.render import RenderMixin
from podcast_mcp.engines.ffmpeg.render_filters import (
    MASTER_SEMANTICS_REV as MASTER_SEMANTICS_REV,
)
from podcast_mcp.engines.ffmpeg.render_filters import (
    MIX_SEMANTICS_REV as MIX_SEMANTICS_REV,
)
from podcast_mcp.engines.ffmpeg.render_filters import (
    automatic_gain_expression as automatic_gain_expression,
)
from podcast_mcp.engines.ffmpeg.render_filters import (
    mute_gain_expression as mute_gain_expression,
)
from podcast_mcp.models import EpisodeProject, Track
from podcast_mcp.util import process
from podcast_mcp.util.binaries import (
    IN_PROCESS_LABEL,
    FFmpegPair,
    FFmpegPairResolutionError,
    in_process_problem,
)
from podcast_mcp.util.process import (
    PIPE,
    CalledProcessError,
    TimeoutExpired,
)


class FFmpegEngine(
    RenderMixin, EncodeMixin, MixMixin, DiagnosticsMixin, LoudnessMixin, ProbeMixin, DecodeMixin
):
    def __init__(
        self,
        ffmpeg: str | None = None,
        ffprobe: str | None = None,
        *,
        _admitted_pair: FFmpegPair | None = None,
    ) -> None:
        pair = _admitted_pair or runtime.resolve_ffmpeg_pair(ffmpeg, ffprobe)
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
            ffmpeg or runtime.resolve_ffmpeg(),
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
        r = runtime.run(cmd, capture_output=True)
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
                runtime.resolve_ffmpeg_pair().ffmpeg,
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
            rate: runtime.popen(command, stdin=PIPE, stdout=PIPE, stderr=PIPE)
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

    def check_available(self) -> tuple[bool, str]:
        try:
            pair = runtime.resolve_ffmpeg_pair(self.ffmpeg, self.ffprobe, force_refresh=True)
        except FFmpegPairResolutionError as exc:
            return False, str(exc)
        if pair.is_in_process:
            problem = in_process_problem()
            return (True, IN_PROCESS_LABEL) if problem is None else (False, problem)
        return True, "FFmpeg/FFprobe " + ".".join(map(str, pair.version))

    def check_ffprobe_version(self) -> tuple[bool, str]:
        try:
            result = process.run(
                [self.ffprobe, "-version"], capture_output=True, text=True, timeout=10
            )
        except (OSError, TimeoutExpired):
            return False, "ffprobe not found"
        if result.returncode == 0:
            return True, result.stdout.splitlines()[0] if result.stdout else "ok"
        return False, result.stderr or "ffprobe failed"

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
        with tempfile.TemporaryFile() as err, runtime.popen(cmd, stdout=PIPE, stderr=err) as proc:
            try:
                if proc.stdout is None:
                    raise RuntimeError("ffmpeg progress pipe missing")
                for raw in proc.stdout:
                    done = runtime._progress_seconds(raw.decode("utf-8", "replace"))
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

    def render_dialogue_track(
        self,
        project: EpisodeProject,
        track: Track,
        output_path: Path,
        defaults: dict,
    ) -> Path:
        from podcast_mcp.engines.timeline_render import render_track_from_timeline

        return render_track_from_timeline(project, track, output_path, defaults, engine=self)


if TYPE_CHECKING:
    from podcast_mcp.engines.ffmpeg.host import FFmpegSelf

    _host_conforms: FFmpegSelf = FFmpegEngine()
