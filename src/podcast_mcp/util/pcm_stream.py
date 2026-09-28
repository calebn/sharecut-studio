"""Forward-only window reads over a streamed decode.

Serves start-ordered windows (prosody segments, and later forced-alignment
windows) so analysis never holds a whole track's samples in memory.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Iterator

import numpy as np


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
        if i0 < self._last_start:
            raise ValueError(
                "SequentialWindowReader windows must not start earlier than the last one"
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
        return self._buf[lo:hi], (self._buf_start + lo) / self.sample_rate

    def close(self) -> None:
        close = getattr(self._chunks, "close", None)
        if callable(close):
            close()
