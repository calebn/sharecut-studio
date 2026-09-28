"""Forward-only window reads over a streamed decode.

Serves start-ordered windows (prosody segments, CTC forced-alignment windows)
so analysis never holds a whole track's samples in memory. Also home to the
shared empty-decode error (:class:`NoAudioDecodedError`).
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Iterator

import numpy as np


def no_audio_decoded_message(path: object) -> str:
    """Text for an ffmpeg decode of ``path`` that exited cleanly but yielded no samples."""
    return f"no audio decoded from {path}"


class NoAudioDecodedError(ValueError):
    """An ffmpeg decode of ``path`` exited cleanly but yielded no samples."""

    def __init__(self, path: object) -> None:
        super().__init__(no_audio_decoded_message(path))


class SequentialWindowReader:
    """Serve ``[start, end)`` sample windows, in non-decreasing start order, from a chunk stream.

    Keeps only samples at or after the latest requested start (plus the chunk being
    read), so resident audio is about one window plus one chunk. ``close()`` closes the
    underlying iterable when it has a ``close`` (e.g. an ffmpeg generator); use
    ``contextlib.closing``.
    """

    def __init__(self, chunks: Iterable[np.ndarray], sample_rate: int) -> None:
        if sample_rate < 1:
            raise ValueError("sample_rate must be >= 1")
        self.sample_rate = sample_rate
        self._chunks = chunks
        self._iter: Iterator[np.ndarray] = iter(chunks)
        self._buf: np.ndarray = np.zeros(0, dtype=np.float32)
        self._buf_start = 0  # absolute sample index of self._buf[0]
        self._last_start = 0
        self._done = False

    @property
    def buffered_samples(self) -> int:
        return int(self._buf.size)

    @property
    def end_sec(self) -> float | None:
        """Media duration once the stream is exhausted, else ``None``."""
        if not self._done:
            return None
        return (self._buf_start + self._buf.size) / self.sample_rate

    def _drop_before(self, index: int) -> None:
        drop = min(max(0, index - self._buf_start), self._buf.size)
        if drop:
            self._buf = self._buf[drop:]
            self._buf_start += drop

    def window(self, start_sec: float, end_sec: float) -> tuple[np.ndarray, float]:
        """``(samples, t0)`` for ``[start_sec, end_sec)``, clamped to the media.

        Indices are ``floor(start * sr)`` .. ``ceil(end * sr)``; ``t0`` is the first
        returned sample's time. Raises ``ValueError`` when ``start_sec`` maps before the
        previous window's start (those samples are gone).
        """
        i0 = max(0, math.floor(start_sec * self.sample_rate))
        i1 = max(i0, math.ceil(end_sec * self.sample_rate))
        first, buf_start = self._take(i0, i1, f"{start_sec:.3f}s (sample {i0})")
        return first, buf_start / self.sample_rate

    def window_samples(self, start: int, end: int) -> tuple[np.ndarray, int]:
        """``(samples, first_index)`` for the exact ``[start, end)`` sample range, clamped to the media.

        Unlike ``window()``, indices are used as given, with no floor/ceil rounding.
        Raises ``ValueError`` under the same ordering rule as ``window()``.
        """
        i0 = max(0, start)
        return self._take(i0, max(i0, end), f"sample {i0}")

    def _take(self, i0: int, i1: int, where: str) -> tuple[np.ndarray, int]:
        if i0 < self._last_start:
            raise ValueError(
                f"SequentialWindowReader: window start {where} "
                f"precedes the previous start sample {self._last_start}"
            )
        self._last_start = i0
        self._drop_before(i0)
        while not self._done and self._buf_start + self._buf.size < i1:
            try:
                chunk = np.asarray(next(self._iter)).reshape(-1)
            except StopIteration:
                self._done = True
                break
            if self._buf.size == 0 and self._buf_start + chunk.size <= i0:
                self._buf_start += chunk.size  # wholly before the window: never buffered
                continue
            self._buf = np.concatenate([self._buf, chunk])
            self._drop_before(i0)
        lo = min(max(0, i0 - self._buf_start), self._buf.size)
        hi = min(max(lo, i1 - self._buf_start), self._buf.size)
        return self._buf[lo:hi], self._buf_start + lo

    def close(self) -> None:
        close = getattr(self._chunks, "close", None)
        if callable(close):
            close()
