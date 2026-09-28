"""Behavioral contracts for shared backend helpers."""

from __future__ import annotations

import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.ranges import merge_intervals, merge_timeline_ranges
from podcast_mcp.edits.timeline_span import source_span_timeline_bounds
from podcast_mcp.models import load_project
from podcast_mcp.util.atomic_render import remove_partials, render_atomic
from podcast_mcp.util.dsp import clamp, clamp01, linear_rms
from podcast_mcp.util.tracks import existing_stem_path, stem_path


@pytest.mark.parametrize(
    "module,symbol",
    [
        ("podcast_mcp.engines.session_timeline", "SessionTimeline"),
        ("podcast_mcp.engines.audio_audit", "TrackRmsCache"),
    ],
)
def test_engine_imports_work_in_fresh_process(module: str, symbol: str) -> None:
    completed = subprocess.run(
        [sys.executable, "-c", f"from {module} import {symbol}"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr


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


def test_render_atomic_reaps_only_its_targets_orphan_partials(tmp_path: Path) -> None:
    dest = tmp_path / "host.wav"
    orphan = tmp_path / f"host.123.{'a' * 32}.partial.wav"
    other_track = tmp_path / f"host.1.123.{'b' * 32}.partial.wav"
    unrelated = tmp_path / "host.notes.partial.wav"
    for path in (orphan, other_track, unrelated):
        path.write_bytes(b"x")
    render_atomic(dest, lambda tmp: tmp.write_bytes(b"new"), reap_partials=True)
    assert dest.read_bytes() == b"new"
    assert not orphan.exists()
    assert other_track.exists() and unrelated.exists()
    assert remove_partials(tmp_path / "missing" / "x.wav") == 0


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
    assert (clamp(-1.0, 0.0, 1.0), clamp(0.5, 0.0, 1.0), clamp(2.0, 0.0, 1.0)) == (0.0, 0.5, 1.0)
    assert (clamp(-5.0, hi=1.0), clamp(5.0, lo=1.0), clamp(3.0)) == (-5.0, 5.0, 3.0)
    assert clamp(0.5, 2.0, 1.0) == 2.0  # lo wins when the bounds cross
    assert linear_rms(np.array([], dtype=np.float64)) == 0.0
    assert linear_rms(np.array([0.0, 1.0])) == pytest.approx(2**-0.5)


def test_existing_stem_path_requires_file(minimal_project) -> None:
    project = load_project(minimal_project)
    stem = stem_path(project, "host")
    assert existing_stem_path(project, "host") is None
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(b"stem")
    assert existing_stem_path(project, "host") == stem


def test_render_atomic_runs_before_replace_between_render_and_swap(tmp_path: Path) -> None:
    dest = tmp_path / "stem.wav"
    dest.write_bytes(b"old")
    seen: dict[str, bytes] = {}

    def render(tmp: Path) -> None:
        tmp.write_bytes(b"new")
        seen["render"] = dest.read_bytes()

    render_atomic(dest, render, before_replace=lambda: seen.update(hook=dest.read_bytes()))
    assert seen == {"render": b"old", "hook": b"old"}
    assert dest.read_bytes() == b"new"

    called: list[bool] = []

    def fail(_tmp: Path) -> None:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        render_atomic(dest, fail, before_replace=lambda: called.append(True))
    assert called == []
    assert dest.read_bytes() == b"new"
