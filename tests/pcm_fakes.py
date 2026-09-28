"""Shared fakes for tests that stream a decode through SequentialWindowReader."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np


class FakeStreamEngine:
    """A ``FFmpegEngine.stream_mono_f32`` stand-in over an in-memory track.

    Tracks how many streams were opened and whether the most recently opened
    stream's generator was closed (its ``finally`` ran).
    """

    def __init__(self, track: np.ndarray, sr: int, chunk_frames: int = 4000) -> None:
        self.track = track
        self.sr = sr
        self.chunk_frames = chunk_frames
        self.calls = 0
        self.closed = False
        self.yielded = 0

    def stream_mono_f32(
        self, path: Path, *, sample_rate: int, chunk_frames: int | None = None
    ) -> Any:
        assert sample_rate == self.sr
        self.calls += 1
        track = self.track
        size = self.chunk_frames

        def gen() -> Any:
            try:
                for i in range(0, track.size, size):
                    self.yielded += 1
                    yield track[i : i + size]
            finally:
                self.closed = True

        return gen()
