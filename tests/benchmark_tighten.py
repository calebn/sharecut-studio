"""Tighten propose/apply benchmarks (run with pytest -m slow)."""

from __future__ import annotations

import copy
import json
import time
from dataclasses import dataclass, field
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.edits import apply_tighten_decisions, propose_tighten_edits
from podcast_mcp.edits.decisions import _edit_to_timeline_range
from podcast_mcp.edits.ranges import merge_timeline_ranges
from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
)


@dataclass
class TightenBenchmarkResult:
    propose_sec: float = 0.0
    apply_sec: float = 0.0
    decisions_proposed: int = 0
    merged_ranges: int = 0
    load_mono_window_calls: int = 0
    rebuild_combined_calls: int = 0
    clip_counts: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "propose_sec": round(self.propose_sec, 3),
            "apply_sec": round(self.apply_sec, 3),
            "total_sec": round(self.propose_sec + self.apply_sec, 3),
            "decisions_proposed": self.decisions_proposed,
            "merged_ranges": self.merged_ranges,
            "load_mono_window_calls": self.load_mono_window_calls,
            "rebuild_combined_calls": self.rebuild_combined_calls,
            "clip_counts": self.clip_counts,
        }


def _trim_project(project: EpisodeProject, max_sec: float) -> EpisodeProject:
    p = copy.deepcopy(project)
    for track in p.tracks:
        if track.media and track.media.duration_sec:
            track.media.duration_sec = min(track.media.duration_sec, max_sec)
    p.clips = [
        Clip(
            id=f"clip_{t.id}_full",
            track_id=t.id,
            source_start=0.0,
            source_end=max_sec,
            timeline_start=0.0,
        )
        for t in p.tracks
        if t.role == TrackRole.DIALOGUE
    ]
    for tr in p.transcripts:
        tr.words = [w for w in tr.words if w.start < max_sec]
    p.edit_decisions = []
    p.timeline.duration_sec = max_sec
    return p


def _synthetic_filler_project(word_count: int = 4000) -> EpisodeProject:
    p = EpisodeProject.create("bench", "/tmp/bench")
    for tid in ("host", "guest"):
        p.timeline.tracks.append(
            Track(
                id=tid,
                label=tid,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=float(word_count)),
            )
        )
        p.timeline.clips.append(
            Clip(
                id=f"full_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=float(word_count),
                timeline_start=0.0,
            )
        )
        words: list[TranscriptWord] = []
        t = 0.0
        for i in range(word_count):
            token = "um" if i % 17 == 0 else "word"
            dur = 0.25
            words.append(TranscriptWord(text=token, start=t, end=t + dur))
            t += dur + (1.5 if i % 23 == 0 else 0.15)
        p.transcripts.append(Transcript(track_id=tid, words=words))
    return p


def run_tighten_benchmark(project: EpisodeProject) -> TightenBenchmarkResult:
    from podcast_mcp.engines import align

    result = TightenBenchmarkResult()
    defaults = load_defaults()
    original_load = align.load_mono_window
    original_rebuild = rebuild_combined

    def counting_load(*args, **kwargs):
        result.load_mono_window_calls += 1
        return original_load(*args, **kwargs)

    def counting_rebuild(proj: EpisodeProject) -> None:
        result.rebuild_combined_calls += 1
        original_rebuild(proj)

    align.load_mono_window = counting_load  # type: ignore[method-assign]
    import podcast_mcp.edits.transcript_sync as transcript_sync

    transcript_sync.rebuild_combined = counting_rebuild  # type: ignore[assignment]

    try:
        t0 = time.perf_counter()
        proposed = propose_tighten_edits(project, defaults, replace_existing=True)
        result.propose_sec = time.perf_counter() - t0
        result.decisions_proposed = len(proposed.decisions)

        ranges: list[tuple[float, float]] = []
        for e in project.edit_decisions:
            if (e.reason or "").startswith(("filler:", "pause:")):
                ranges.append(_edit_to_timeline_range(project, e))
        result.merged_ranges = len(merge_timeline_ranges(ranges))

        t1 = time.perf_counter()
        apply_tighten_decisions(project)
        result.apply_sec = time.perf_counter() - t1

        for tid in {t.id for t in project.tracks if t.role == TrackRole.DIALOGUE}:
            result.clip_counts[tid] = len([c for c in project.clips if c.track_id == tid])
    finally:
        align.load_mono_window = original_load  # type: ignore[method-assign]
        transcript_sync.rebuild_combined = original_rebuild  # type: ignore[assignment]

    return result


@pytest.mark.slow
def test_tighten_benchmark_synthetic_under_threshold():
    project = _synthetic_filler_project(word_count=3000)
    result = run_tighten_benchmark(project)
    assert result.load_mono_window_calls == 0
    assert result.rebuild_combined_calls == 1
    assert result.decisions_proposed > 0
    assert result.propose_sec < 5.0
    assert result.apply_sec < 5.0
    host = project.tracks[0].id
    guest = project.tracks[1].id
    assert result.clip_counts[host] == result.clip_counts[guest]


@pytest.mark.slow
def test_tighten_benchmark_optional_cleanup_test():
    from optional_projects import cleanup_test_project

    path = cleanup_test_project()
    if path is None:
        pytest.skip(
            "podcast-cleanup-test not available "
            "(set PODCAST_CLEANUP_TEST_PROJECT or use a sibling checkout)"
        )
    project = _trim_project(load_project(path), max_sec=600.0)
    result = run_tighten_benchmark(project)
    assert result.load_mono_window_calls == 0
    assert result.rebuild_combined_calls == 1
    assert result.propose_sec < 30.0
    assert result.apply_sec < 30.0
    print(json.dumps(result.to_dict(), indent=2))


def run_tighten_apply_word_only_benchmark(project: EpisodeProject) -> TightenBenchmarkResult:
    from podcast_mcp.edits.timeline_ops import batch_ripple_delete
    from podcast_mcp.engines import align

    result = TightenBenchmarkResult()
    defaults = load_defaults()
    original_load = align.load_mono_window

    def counting_load(*args, **kwargs):
        result.load_mono_window_calls += 1
        return original_load(*args, **kwargs)

    align.load_mono_window = counting_load  # type: ignore[method-assign]
    try:
        propose_tighten_edits(project, defaults, replace_existing=True)
        result.decisions_proposed = len(
            [
                e
                for e in project.edit_decisions
                if (e.reason or "").startswith(("filler:", "pause:"))
            ]
        )
        ranges = [
            _edit_to_timeline_range(project, e)
            for e in project.edit_decisions
            if (e.reason or "").startswith(("filler:", "pause:"))
        ]
        result.merged_ranges = len(merge_timeline_ranges(ranges))
        with patch(
            "podcast_mcp.edits.inaudible_cuts._snap_boundary_to_waveform",
            side_effect=lambda _path, center, **kwargs: center,
        ):
            t0 = time.perf_counter()
            batch_ripple_delete(project, ranges, use_inaudible_opt=True)
            result.apply_sec = time.perf_counter() - t0
        for tid in {t.id for t in project.tracks if t.role == TrackRole.DIALOGUE}:
            result.clip_counts[tid] = len([c for c in project.clips if c.track_id == tid])
    finally:
        align.load_mono_window = original_load  # type: ignore[method-assign]
    return result


@pytest.mark.slow
def test_tighten_apply_word_only_under_threshold():
    project = _synthetic_filler_project(word_count=2000)
    result = run_tighten_apply_word_only_benchmark(project)
    assert result.load_mono_window_calls == 0
    assert result.decisions_proposed > 0
    assert result.apply_sec < 5.0
    host = project.tracks[0].id
    guest = project.tracks[1].id
    assert result.clip_counts[host] == result.clip_counts[guest]


@pytest.mark.slow
def test_tighten_apply_full_mode_warm_under_threshold():
    from podcast_mcp.edits.timeline_ops import batch_ripple_delete

    project = _synthetic_filler_project(word_count=500)
    propose_tighten_edits(project, load_defaults(), replace_existing=True)
    ranges = [
        _edit_to_timeline_range(project, e)
        for e in project.edit_decisions
        if (e.reason or "").startswith(("filler:", "pause:"))
    ]
    fake = np.array([0.6, 0.4, 0.2, 0.05, 0.01, 0.1, 0.4], dtype=np.float32)
    load_calls = {"n": 0}

    def fast_load(*args, **kwargs):
        load_calls["n"] += 1
        return fake

    with patch(
        "podcast_mcp.edits.inaudible_cuts.load_mono_window",
        side_effect=fast_load,
    ):
        batch_ripple_delete(project, ranges[:20], use_inaudible_opt=None)
        first_calls = load_calls["n"]
        t0 = time.perf_counter()
        batch_ripple_delete(project, ranges[20:40], use_inaudible_opt=None)
        warm_sec = time.perf_counter() - t0

    assert first_calls > 0
    assert warm_sec < 5.0
