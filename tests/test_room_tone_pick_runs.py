"""``_pick_sample`` subtracts the pending edits from its quiet runs in one sweep.

One ``subtract_intervals`` call per eligible run merged the whole ``avoid`` list again for
each run, on every pad of a batch. One call over all runs merges it once and returns the
same pieces in the same order, so the same windows are measured and the same one is picked.
"""

from __future__ import annotations

import random
from pathlib import Path

import pytest

from podcast_mcp.engines import room_tone
from podcast_mcp.engines.room_tone import Sample, TrackFloor
from podcast_mcp.util.intervals import subtract_intervals


def _reference_runs(track, need, near_sec, avoid):
    """The pieces ``_pick_sample`` ranked before: one subtraction per eligible run."""
    eligible = [run for run in track.runs if run[1] - run[0] >= need - 1e-9]
    runs = [
        r
        for run in eligible
        for r in subtract_intervals([run], avoid)
        if r[1] - r[0] >= need - 1e-9
    ]
    runs.sort(key=lambda r: max(r[0] - near_sec, near_sec - r[1], 0.0))
    return runs


def _scene(seed: int):
    rng = random.Random(seed)
    cursor = 0.0
    runs = []
    for _ in range(rng.randint(1, 40)):
        cursor += rng.uniform(0.0, 3.0)
        length = rng.choice([0.0, 0.1, 0.3, rng.uniform(0.25, 6.0)])
        runs.append((cursor, cursor + length))
        cursor += length
    avoid = []
    for _ in range(rng.randint(0, 60)):
        start = rng.uniform(0.0, cursor + 1.0)
        # Edits that touch run boundaries, overlap each other, or are empty.
        avoid.append((start, start + rng.choice([0.0, 0.2, rng.uniform(0.0, 4.0)])))
    track = TrackFloor(Path("x.wav"), -60.0, -20.0, tuple(runs))
    return track, avoid, rng.uniform(0.0, cursor), rng.choice([0.25, 0.5, 1.5, 4.0, 0.0])


@pytest.fixture
def measured(monkeypatch):
    spans: list[tuple[float, float]] = []

    def fake_measure(_track, span):
        spans.append(span)
        return Sample(span[0], span[1], -60.0, 0.0)

    monkeypatch.setattr(room_tone, "_measure", fake_measure)
    # Reject until the third window, so several candidates are visited in order.
    monkeypatch.setattr(
        room_tone, "rejection", lambda _sample, _track: "loud" if len(spans) < 3 else None
    )
    return spans


@pytest.mark.parametrize("seed", range(120))
def test_the_windows_tried_and_the_pick_match_one_subtraction_per_run(seed, measured, monkeypatch):
    track, avoid, near, duration = _scene(seed)
    need = min(duration, room_tone.MIN_SAMPLE_SEC)
    picked = room_tone._pick_sample(track, near_sec=near, duration_sec=duration, avoid=avoid)

    expected = _reference_runs(track, need, near, avoid)
    tried = [room_tone._window_nearest(r, near, duration) for r in expected[: len(measured)]]
    assert measured == tried
    if expected:
        assert len(measured) == min(len(expected), 3 if len(expected) >= 3 else len(expected))
    if isinstance(picked, room_tone.OwnQuietSample):
        assert (picked.sample.start, picked.sample.end) == tried[-1]


def test_the_pending_edits_are_merged_once_per_pick_not_once_per_run(measured, monkeypatch):
    track = TrackFloor(
        Path("x.wav"), -60.0, -20.0, tuple((i * 3.0, i * 3.0 + 2.0) for i in range(30))
    )
    avoid = [(i * 3.0 + 0.5, i * 3.0 + 0.7) for i in range(30)]
    calls: list[int] = []
    real = room_tone.subtract_intervals
    monkeypatch.setattr(
        room_tone,
        "subtract_intervals",
        lambda segs, rem, **kw: calls.append(len(segs)) or real(segs, rem, **kw),
    )

    room_tone._pick_sample(track, near_sec=40.0, duration_sec=1.0, avoid=avoid)

    assert calls == [30]
