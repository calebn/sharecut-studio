from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from podcast_mcp.engines.level_profile import LEVEL_FRAME_SEC


@dataclass(frozen=True)
class SilenceInterval:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


def quiet_intervals(
    levels_db: np.ndarray, *, under_db: float, min_duration_sec: float = 0.5
) -> list[SilenceInterval]:
    """Runs of 10 ms frame levels (:func:`~podcast_mcp.engines.level_profile.frame_levels_db`)
    under ``under_db`` lasting at least ``min_duration_sec``, in source seconds.

    ``under_db`` is a floor read from the same frames' ``LevelProfile``, so a frame is
    compared with the measure the floor was read from (frame RMS, not sample peaks) and
    silence means the same at any recording gain.
    """
    quiet = np.concatenate(([False], np.asarray(levels_db) < under_db, [False]))
    edges = np.flatnonzero(np.diff(quiet.astype(np.int8)))
    per_sec = round(1 / LEVEL_FRAME_SEC)
    min_frames = min_duration_sec * per_sec
    return [
        SilenceInterval(start=a / per_sec, end=b / per_sec)
        for a, b in zip(edges[::2], edges[1::2], strict=True)
        if b - a >= min_frames - 1e-9
    ]
