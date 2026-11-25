from __future__ import annotations

import functools
import tempfile
import threading
from collections.abc import Generator
from pathlib import Path
from typing import IO, TYPE_CHECKING

import numpy as np

from podcast_mcp.engines.ffmpeg import runtime
from podcast_mcp.engines.ffmpeg.runtime import _UNTRUSTED_PROTOCOLS
from podcast_mcp.engines.media_seek import MediaSeek
from podcast_mcp.engines.mono_downmix import ffmpeg_mono_mean_layout
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.pcm_stream import NoAudioDecodedError
from podcast_mcp.util.process import PIPE

if TYPE_CHECKING:
    from podcast_mcp.engines.ffmpeg.host import FFmpegSelf

# Raw float32 PCM decode (waveform pyramid builds and deep-zoom windows). The
# timeouts are watchdogs armed only while waiting on ffmpeg for one chunk, so
# consumer time between chunks never counts toward them.
PCM_STREAM_CHUNK_FRAMES = 1_048_576
PCM_STREAM_TIMEOUT_SEC = 600.0
PCM_WINDOW_TIMEOUT_SEC = 30.0


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


class DecodeMixin:
    def decode_full_f32(
        self: FFmpegSelf, path: Path, *, sample_rate: int, layout: list[str]
    ) -> np.ndarray:
        """Decode the first audio stream into a nonempty flat float32 byte view."""
        result = runtime.run(
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

    def stream_pcm_f32(
        self: FFmpegSelf,
        path: Path,
        *,
        chunk_frames: int = PCM_STREAM_CHUNK_FRAMES,
        timeout_sec: float | None = None,
    ) -> tuple[int, int, Generator[np.ndarray, None, None]]:
        """Decode *path* to interleaved float32 PCM at its native rate and layout.

        Returns ``(sample_rate, channels, chunks)``; each chunk is a
        ``(frames, channels)`` float32 array of ``chunk_frames`` frames (the
        last may be shorter). ffmpeg starts on first ``next()`` and is killed
        when the generator closes, or when one chunk waits on ffmpeg longer than
        ``timeout_sec`` (``PCM_STREAM_TIMEOUT_SEC`` when None; the consumer's time between chunks does not
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
                timeout_sec=PCM_STREAM_TIMEOUT_SEC if timeout_sec is None else timeout_sec,
                expected_duration_sec=expected_duration,
            ),
        )

    def stream_mono_f32(
        self: FFmpegSelf,
        path: Path,
        *,
        sample_rate: int,
        chunk_frames: int = PCM_STREAM_CHUNK_FRAMES,
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

    def decode_window_f32(
        self: FFmpegSelf, path: Path, start_frame: int, frames: int, sample_rate: int, channels: int
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
        self: FFmpegSelf,
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
            proc = runtime.popen(argv, stdout=PIPE, stderr=err)
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
                                runtime._pcm_decode_error(
                                    code, timed_out.is_set(), timeout_sec, err
                                )
                            )
                        if expected_duration_sec is not None:
                            err.seek(0, 2)
                            err.seek(max(0, err.tell() - runtime.PCM_STDERR_TAIL_BYTES))
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
                                    if (seconds := runtime._progress_seconds(line)) is not None
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
