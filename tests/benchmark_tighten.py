"""Tighten propose/apply benchmarks (run with ``pytest -m slow tests/benchmark_tighten.py``).

The file is not named ``test_*``, so the default suite never collects it.
``tests/test_benchmark_tighten_smoke.py`` runs every scenario here on a tiny project in
the normal suite so the helpers cannot rot unnoticed (#1129).
"""

from __future__ import annotations

import copy
import json
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.edits import apply_tighten_decisions, propose_tighten_edits
from podcast_mcp.edits.decisions import _edit_to_timeline_range, approve_edits
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
from podcast_mcp.util.wav import pcm_wav_header
from ripple_helpers import ripple_cut_spans

_AUDIO_RATE = 16_000


@dataclass
class TightenBenchmarkResult:
    propose_sec: float = 0.0
    apply_sec: float = 0.0
    decisions_proposed: int = 0
    decisions_applied: int = 0
    merged_ranges: int = 0
    ffmpeg_window_calls: int = 0
    rebuild_combined_calls: int = 0
    clip_counts: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "propose_sec": round(self.propose_sec, 3),
            "apply_sec": round(self.apply_sec, 3),
            "total_sec": round(self.propose_sec + self.apply_sec, 3),
            "decisions_proposed": self.decisions_proposed,
            "decisions_applied": self.decisions_applied,
            "merged_ranges": self.merged_ranges,
            "ffmpeg_window_calls": self.ffmpeg_window_calls,
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


def _write_noise_wav(path: Path, duration_sec: float, *, seed: int) -> None:
    """Write a quiet mono PCM WAV so the tighten audio cache has real audio to decode."""
    rng = np.random.default_rng(seed)
    samples = (rng.standard_normal(int(duration_sec * _AUDIO_RATE)) * 40.0).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(pcm_wav_header(samples.nbytes, _AUDIO_RATE) + samples.tobytes())


def _synthetic_filler_project(word_count: int, workspace: Path) -> EpisodeProject:
    """Two dialogue tracks of ``word_count`` words with fillers and pauses, audio on disk.

    The audio must exist: tighten decodes each track once into a ``TrackAudioCache`` and a
    track whose media cannot be decoded falls back to one ffmpeg subprocess per window
    read, which turned this benchmark into a multi-minute hang.
    """
    p = EpisodeProject.create("bench", str(workspace))
    for seed, tid in enumerate(("host", "guest")):
        words: list[TranscriptWord] = []
        t = 0.0
        for i in range(word_count):
            token = "um" if i % 17 == 0 else "word"
            dur = 0.25
            words.append(TranscriptWord(text=token, start=t, end=t + dur))
            t += dur + (1.5 if i % 23 == 0 else 0.15)
        duration = t + 1.0
        _write_noise_wav(workspace / "raw" / f"{tid}.wav", duration, seed=seed)
        p.timeline.tracks.append(
            Track(
                id=tid,
                label=tid,
                role=TrackRole.DIALOGUE,
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=duration),
            )
        )
        p.timeline.clips.append(
            Clip(
                id=f"full_{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=duration,
                timeline_start=0.0,
            )
        )
        p.transcripts.append(Transcript(track_id=tid, words=words))
    return p


@contextmanager
def _count_ffmpeg_window_reads(result: TightenBenchmarkResult) -> Iterator[None]:
    """Count per-window ffmpeg spawns made by ``load_mono_window``.

    Counted at ``align.run`` because callers import ``load_mono_window`` by name, so
    wrapping that function would never see them.
    """
    from podcast_mcp.engines import align

    original_run = align.run

    def counting_run(*args, **kwargs):
        result.ffmpeg_window_calls += 1
        return original_run(*args, **kwargs)

    with patch.object(align, "run", counting_run):
        yield


@contextmanager
def _count_rebuild_combined(result: TightenBenchmarkResult) -> Iterator[None]:
    import podcast_mcp.edits.transcript_sync as transcript_sync

    original_rebuild = rebuild_combined

    def counting_rebuild(proj: EpisodeProject) -> None:
        result.rebuild_combined_calls += 1
        original_rebuild(proj)

    with patch.object(transcript_sync, "rebuild_combined", counting_rebuild):
        yield


def _pause_ids(project: EpisodeProject, *, pauses: bool) -> list[str]:
    """The pause trims the benchmark's reviewer approves (none when ``pauses`` is off)."""
    return [
        e.id for e in project.edit_decisions if pauses and (e.reason or "").startswith("pause:")
    ]


def _hold_back_fillers(project: EpisodeProject, *, fillers: bool) -> None:
    if not fillers:
        for e in project.edit_decisions:
            if (e.reason or "").startswith("filler:"):
                e.review_required = True


def run_tighten_benchmark(
    project: EpisodeProject, *, fillers: bool = True, pauses: bool = True
) -> TightenBenchmarkResult:
    result = TightenBenchmarkResult()
    defaults = load_defaults()

    with _count_ffmpeg_window_reads(result), _count_rebuild_combined(result):
        t0 = time.perf_counter()
        proposed = propose_tighten_edits(project, defaults, replace_existing=True)
        result.propose_sec = time.perf_counter() - t0
        result.decisions_proposed = len(proposed.decisions)
        # Pause trims are review-only (#1055): a reviewer approves them, and apply-all
        # takes the fillers.
        _hold_back_fillers(project, fillers=fillers)
        approved = _pause_ids(project, pauses=pauses)
        result.decisions_applied = len(approved) + sum(
            1
            for e in project.edit_decisions
            if (e.reason or "").startswith("filler:") and not e.review_required
        )

        ranges: list[tuple[float, float]] = []
        for e in project.edit_decisions:
            if (e.reason or "").startswith(("filler:", "pause:")):
                ranges.append(_edit_to_timeline_range(project, e))
        result.merged_ranges = len(merge_timeline_ranges(ranges))

        t1 = time.perf_counter()
        if approved:
            approve_edits(project, approved, confirm_cut_speech=True)
        apply_tighten_decisions(project)
        result.apply_sec = time.perf_counter() - t1

        for tid in {t.id for t in project.tracks if t.role == TrackRole.DIALOGUE}:
            result.clip_counts[tid] = len([c for c in project.clips if c.track_id == tid])

    return result


MAX_REBUILDS_PER_DECISION = 3


def _assert_ripple_apply_shape(result: TightenBenchmarkResult) -> None:
    """Structural invariants of a propose + apply run, independent of wall-clock speed."""
    assert result.ffmpeg_window_calls == 0
    assert result.decisions_proposed > 0
    assert result.decisions_applied > 0
    assert 0 < result.rebuild_combined_calls <= MAX_REBUILDS_PER_DECISION * result.decisions_applied
    assert len(set(result.clip_counts.values())) == 1


@pytest.mark.slow
def test_tighten_benchmark_synthetic_under_threshold(tmp_path):
    result = run_tighten_benchmark(_synthetic_filler_project(1000, tmp_path))
    _assert_ripple_apply_shape(result)
    # Per-cut budgets (measured ~0.1 s each): a superlinear regression trips them as the
    # project grows, while a slower machine does not.
    assert result.propose_sec / result.decisions_proposed < 0.5
    assert result.apply_sec / result.merged_ranges < 0.5


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
    assert result.ffmpeg_window_calls == 0
    assert result.propose_sec < 30.0
    assert result.apply_sec < 30.0
    print(json.dumps(result.to_dict(), indent=2))


def run_tighten_apply_word_only_benchmark(project: EpisodeProject) -> TightenBenchmarkResult:
    result = TightenBenchmarkResult()
    defaults = load_defaults()

    with _count_ffmpeg_window_reads(result):
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
            ripple_cut_spans(project, ranges, use_inaudible_opt=True)
            result.apply_sec = time.perf_counter() - t0
        for tid in {t.id for t in project.tracks if t.role == TrackRole.DIALOGUE}:
            result.clip_counts[tid] = len([c for c in project.clips if c.track_id == tid])
    return result


@pytest.mark.slow
def test_tighten_apply_word_only_under_threshold(tmp_path):
    result = run_tighten_apply_word_only_benchmark(_synthetic_filler_project(1000, tmp_path))
    assert result.ffmpeg_window_calls == 0
    assert result.decisions_proposed > 0
    assert len(set(result.clip_counts.values())) == 1
    assert result.apply_sec / result.merged_ranges < 0.5


def run_tighten_apply_full_mode_warm_benchmark(project: EpisodeProject) -> tuple[int, float]:
    """Return (window reads on the first batch, seconds for a second batch on a warm cache)."""
    propose_tighten_edits(project, load_defaults(), replace_existing=True)
    ranges = [
        _edit_to_timeline_range(project, e)
        for e in project.edit_decisions
        if (e.reason or "").startswith(("filler:", "pause:"))
    ]
    half = len(ranges) // 2
    fake = np.array([0.6, 0.4, 0.2, 0.05, 0.01, 0.1, 0.4], dtype=np.float32)
    load_calls = {"n": 0}

    def fast_load(*args, **kwargs):
        load_calls["n"] += 1
        return fake

    with patch(
        "podcast_mcp.edits.inaudible_cuts.load_mono_window",
        side_effect=fast_load,
    ):
        ripple_cut_spans(project, ranges[:half], use_inaudible_opt=None)
        first_calls = load_calls["n"]
        t0 = time.perf_counter()
        ripple_cut_spans(project, ranges[half:], use_inaudible_opt=None)
        warm_sec = time.perf_counter() - t0
    return first_calls, warm_sec


@pytest.mark.slow
def test_tighten_apply_full_mode_warm_under_threshold(tmp_path):
    first_calls, warm_sec = run_tighten_apply_full_mode_warm_benchmark(
        _synthetic_filler_project(500, tmp_path)
    )
    assert first_calls > 0
    assert warm_sec < 5.0
