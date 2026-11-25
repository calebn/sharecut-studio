from __future__ import annotations

import tempfile
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from podcast_mcp.engines.audio import MuteEnvelope, SourceAudio
from podcast_mcp.engines.ffmpeg import runtime
from podcast_mcp.engines.media_seek import MediaSeek
from podcast_mcp.engines.render_clock import spawn_or_too_long
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.process import PIPE

if TYPE_CHECKING:
    from podcast_mcp.engines.ffmpeg.host import FFmpegSelf


class EncodeMixin:
    def encode_flac_f32(
        self: FFmpegSelf,
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
        with tempfile.TemporaryFile() as err, runtime.popen(argv, stdin=PIPE, stderr=err) as proc:
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

    def export_audio(
        self: FFmpegSelf,
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
            spawn_or_too_long(runtime.run, cmd, check=True, capture_output=True)
        else:
            runtime._run_cancellable(cmd, cancel_check)
        return output_path

    def export_mp3(
        self: FFmpegSelf,
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

    def extract_segment(
        self: FFmpegSelf,
        src: Path,
        output_path: Path,
        start_sec: float,
        end_sec: float,
        *,
        mute_spans: tuple[MuteEnvelope, ...] = (),
        gain_db: float = 0.0,
    ) -> Path:
        """Extract [start_sec, end_sec] from src into output_path (non-destructive).

        ``mute_spans`` are seconds from the start of the extracted window (same
        clock as ``mute_spans_for_source_window``).
        """
        output_path.parent.mkdir(parents=True, exist_ok=True)
        if mute_spans or gain_db:
            # Same atrim + asetpts + volume graph as render_timeline so `t` in
            # the mute expression matches output samples (plain -ss/-af does not).
            return self.render_timeline(
                output_path,
                SourceAudio(
                    src, max(0.0, start_sec), end_sec, mute_spans=mute_spans, gain_db=gain_db
                ),
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
        runtime.run(cmd, check=True, capture_output=True)
        return output_path
