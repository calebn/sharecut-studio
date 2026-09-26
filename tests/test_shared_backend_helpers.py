"""Behavioral contracts for shared backend helpers."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.ranges import merge_intervals, merge_timeline_ranges
from podcast_mcp.edits.timeline_span import source_span_timeline_bounds
from podcast_mcp.models import load_project
from podcast_mcp.util.atomic_render import render_atomic
from podcast_mcp.util.dsp import clamp01, linear_rms
from podcast_mcp.util.tracks import existing_stem_path, stem_path


def test_merge_intervals_preserves_caller_gap_and_unsorted_inputs() -> None:
    spans = [(2.0, 3.0), (0.0, 1.0), (1.0 + 5e-7, 1.5)]
    assert merge_intervals(spans, gap=1e-9) == [(0.0, 1.0), (1.0000005, 1.5), (2.0, 3.0)]
    assert merge_timeline_ranges(spans) == [(0.0, 1.5), (2.0, 3.0)]
    assert merge_intervals([]) == []


def test_source_span_bounds_uses_caller_fallback() -> None:
    class Timeline:
        def map_source_span(
            self, track_id: str, start: float, end: float
        ) -> list[tuple[float, float]]:
            assert track_id == "host"
            assert (start, end) == (1.0, 3.0)
            return [(4.0, 5.0), (6.0, 7.0)]

    timeline = Timeline()
    assert source_span_timeline_bounds(timeline, "host", 1.0, 3.0) == (4.0, 7.0)
    timeline.map_source_span = lambda *_: []
    assert source_span_timeline_bounds(timeline, "host", 1.0, 3.0, default=(1.0, 3.0)) == (
        1.0,
        3.0,
    )


def test_render_atomic_parallel_writers_and_cleanup(tmp_path: Path) -> None:
    dest = tmp_path / "image.png"

    def write(value: bytes) -> Path:
        return render_atomic(dest, lambda tmp: tmp.write_bytes(value))

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(write, (b"one", b"two"))) == [dest, dest]
    assert dest.read_bytes() in {b"one", b"two"}
    assert list(tmp_path.iterdir()) == [dest]

    def fail(tmp: Path) -> None:
        tmp.write_bytes(b"partial")
        raise RuntimeError("render failed")

    with pytest.raises(RuntimeError, match="render failed"):
        render_atomic(dest, fail)
    assert dest.read_bytes() in {b"one", b"two"}
    assert list(tmp_path.iterdir()) == [dest]


def test_numeric_helpers_preserve_edge_values() -> None:
    assert (clamp01(-1.0), clamp01(0.25), clamp01(2.0)) == (0.0, 0.25, 1.0)
    assert linear_rms(np.array([], dtype=np.float64)) == 0.0
    assert linear_rms(np.array([0.0, 1.0])) == pytest.approx(2**-0.5)


def test_existing_stem_path_requires_file(minimal_project) -> None:
    project = load_project(minimal_project)
    stem = stem_path(project, "host")
    assert existing_stem_path(project, "host") is None
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(b"stem")
    assert existing_stem_path(project, "host") == stem
