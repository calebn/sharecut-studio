from __future__ import annotations

import numpy as np

from podcast_mcp.engines.silence import SilenceInterval, quiet_intervals


def test_quiet_intervals_are_runs_of_frames_under_the_floor_long_enough() -> None:
    levels = np.array([-20.0] * 10 + [-70.0] * 60 + [-20.0] * 5 + [-70.0] * 20 + [-20.0] * 3)
    assert quiet_intervals(levels, under_db=-50.0, min_duration_sec=0.5) == [
        SilenceInterval(start=0.1, end=0.7)
    ]
    assert len(quiet_intervals(levels, under_db=-50.0, min_duration_sec=0.2)) == 2


def test_quiet_intervals_reach_the_edges_of_the_recording() -> None:
    levels = np.full(80, -90.0)
    assert quiet_intervals(levels, under_db=-50.0, min_duration_sec=0.5) == [
        SilenceInterval(start=0.0, end=0.8)
    ]
    assert quiet_intervals(levels, under_db=float("inf")) == [SilenceInterval(0.0, 0.8)]
    assert quiet_intervals(np.array([]), under_db=-50.0) == []
