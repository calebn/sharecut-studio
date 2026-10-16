"""A span index with duplicated segments narrows candidates like a clean one (#1620)."""

from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    _build_index,
    _candidates_source,
    _candidates_timeline,
)
from podcast_mcp.models import Clip, EpisodeProject, Track, TrackRole


def _overlapping_keys(seed: int) -> tuple[tuple[float, float, float], ...]:
    rng = np.random.default_rng(seed)
    keys = []
    at = 0.0
    for _ in range(60):
        length = float(rng.uniform(0.1, 8.0))
        source = float(rng.uniform(0.0, 120.0))
        keys.append((at, source, source + length))
        at += float(rng.uniform(-1.0, length))
        at = max(at, 0.0)
    return tuple(keys)


def test_candidates_hold_every_overlapping_span_when_segments_repeat():
    keys = _overlapping_keys(1620)
    idx = _build_index(keys)
    assert not idx.source_monotonic
    assert not idx.timeline_monotonic
    rng = np.random.default_rng(7)
    narrowed = 0
    for _ in range(400):
        lo = float(rng.uniform(-2.0, 130.0))
        hi = lo + float(rng.choice([0.0, 0.05, 0.5, 4.0, 40.0]))
        for axis, got in (
            ("source", _candidates_source(idx, lo, hi)),
            ("timeline", _candidates_timeline(idx, lo, hi)),
        ):
            everything = idx.by_source if axis == "source" else idx.by_timeline
            starts = (
                (lambda s: s.source_start) if axis == "source" else (lambda s: s.timeline_start)
            )
            ends = (lambda s: s.source_end) if axis == "source" else (lambda s: s.timeline_end)
            overlapping = [s for s in everything if starts(s) < hi and ends(s) > lo]
            assert all(s in got for s in overlapping)
            narrowed += len(got) < len(everything)
    assert narrowed > 100


def test_mapping_a_source_span_through_repeated_segments_finds_every_placement():
    project = EpisodeProject.create("ep", "/tmp/ws")
    project.tracks = [Track(id="t", label="T", role=TrackRole.DIALOGUE)]
    project.clips = [
        Clip(id="a", track_id="t", source_start=10.0, source_end=20.0, timeline_start=0.0),
        Clip(id="b", track_id="t", source_start=12.0, source_end=14.0, timeline_start=10.0),
        Clip(id="c", track_id="t", source_start=30.0, source_end=35.0, timeline_start=12.0),
    ]
    mapped = SessionTimeline(project).map_source_span("t", 13.0, 13.5)
    assert mapped == [(3.0, 3.5), (11.0, 11.5)]


def test_a_clip_end_still_looks_up_when_segments_repeat():
    project = EpisodeProject.create("ep", "/tmp/ws")
    project.tracks = [Track(id="t", label="T", role=TrackRole.DIALOGUE)]
    project.clips = [
        Clip(id="a", track_id="t", source_start=10.0, source_end=20.0, timeline_start=0.0),
        Clip(id="b", track_id="t", source_start=12.0, source_end=14.0, timeline_start=10.0),
        Clip(id="c", track_id="t", source_start=30.0, source_end=35.0, timeline_start=12.0),
    ]
    idx = _build_index(
        tuple((c.timeline_start, c.source_start, c.source_end) for c in project.clips)
    )
    assert not idx.source_monotonic
    assert SessionTimeline._source_point(idx, 20.0) == 10.0
    assert SessionTimeline._source_point(idx, 20.0 - 5e-10) == pytest.approx(10.0, abs=1e-9)
