"""Smoke-run each scenario in ``tests/benchmark_tighten.py`` on a tiny project (#1129).

The benchmark file is not named ``test_*`` and its tests are ``slow``, so nothing in the
normal suite ran it and it rotted until it hung on ``main``. These tests run the same
helpers on a few dozen words and assert only structure (no ffmpeg window spawns, cuts
applied, tracks in step), never wall-clock time.
"""

from __future__ import annotations

import hashlib
import wave

import pytest

import benchmark_tighten as bench
from podcast_mcp.edits import cut_effects
from podcast_mcp.edits.clips_ops import clip_split_origin
from podcast_mcp.models import CutIntent

_WORDS = 40


@pytest.fixture
def project(tmp_path):
    project = bench._synthetic_filler_project(_WORDS, tmp_path)
    assert [len(t.words) for t in project.transcripts] == [_WORDS, _WORDS]
    assert project.transcripts[0].words[-1].end < project.transcripts[1].words[0].start
    for track in project.tracks:
        with wave.open(str(tmp_path / track.media.path)) as audio:
            assert audio.getnframes() / audio.getframerate() == pytest.approx(
                track.media.duration_sec, abs=1 / bench._AUDIO_RATE
            )
    return project


def test_ripple_benchmark_runs_on_a_tiny_project(project):
    media = {
        path: hashlib.sha256(path.read_bytes()).digest()
        for path in project.workspace_path().glob("raw/*.wav")
    }
    result = bench.run_tighten_benchmark(project)

    assert result.decisions_proposed == 8
    assert result.ffmpeg_window_calls == 0
    assert result.decisions_applied == len(project.editorial.edit_log) == 8
    assert not project.edit_decisions
    assert {path: hashlib.sha256(path.read_bytes()).digest() for path in media} == media
    assert (
        0
        < result.rebuild_combined_calls
        <= bench.MAX_REBUILDS_PER_DECISION * result.decisions_applied
    )
    assert len(set(result.clip_counts.values())) == 1


@pytest.mark.parametrize("kind", ["pauses", "fillers"])
def test_each_kind_of_decision_stays_within_the_rebuild_bound_alone(project, kind, monkeypatch):
    automatic = bench.apply_tighten_decisions
    automatic_applied = []
    receipts = cut_effects.complete_effect_receipts
    moved_pad_checked = []

    def check_receipts(before, candidate, accepted=(), **kwargs):
        held = receipts(before, candidate, accepted, **kwargs)
        if kind == "fillers" and len(accepted) == 4:
            assert not held
            origins = cut_effects.native_pad_origins()
            for row in candidate.editorial.edit_log:
                tile = next(
                    c
                    for c in candidate.clips
                    if (origin := origins.get(clip_split_origin(c.id, set(origins)))) is not None
                    and origin.edit_id == row.decision_ids[0]
                    and c.track_id == next(e.track_id for e in accepted if e.id in row.decision_ids)
                    and c.source_start < row.source_end
                    and c.source_end > row.source_start
                )
                if abs(tile.timeline_start - row.timeline_start) <= 1e-6:
                    continue
                tampered = candidate.model_copy(deep=True)
                next(c for c in tampered.clips if c.id == tile.id).id = "unattributed-copy"
                assert any(
                    h.edit_id in row.decision_ids for h in receipts(before, tampered, accepted)
                )
                malformed = candidate.model_copy(deep=True)
                next(r for r in malformed.editorial.edit_log if r.id == row.id).params[
                    "replace_gap_sec"
                ] = 0
                assert any(
                    h.edit_id in row.decision_ids for h in receipts(before, malformed, accepted)
                )
                moved_pad_checked.append(tile.id)
        return held

    def apply(project, **_kw):
        assert all(e.boundary_intent is CutIntent.PROGRAMMATIC for e in project.edit_decisions)
        count = automatic(project, **_kw)
        automatic_applied.append(count)
        return count

    monkeypatch.setattr(bench, "apply_tighten_decisions", apply)
    monkeypatch.setattr(cut_effects, "complete_effect_receipts", check_receipts)
    result = bench.run_tighten_benchmark(
        project, fillers=kind == "fillers", pauses=kind == "pauses"
    )

    assert result.ffmpeg_window_calls == 0
    assert result.decisions_applied == len(project.editorial.edit_log) == 4
    assert automatic_applied == [4 if kind == "fillers" else 0]
    assert all(r.reason.startswith(kind[:-1] + ":") for r in project.editorial.edit_log)
    assert bool(moved_pad_checked) is (kind == "fillers")
    assert cut_effects.native_pad_origins() == {}
    assert (
        0
        < result.rebuild_combined_calls
        <= bench.MAX_REBUILDS_PER_DECISION * result.decisions_applied
    )


def test_word_only_apply_benchmark_runs_on_a_tiny_project(project):
    result = bench.run_tighten_apply_word_only_benchmark(project)

    assert result.decisions_proposed > 0
    assert result.ffmpeg_window_calls == 0
    assert len(set(result.clip_counts.values())) == 1


def test_warm_full_mode_benchmark_runs_on_a_tiny_project(project):
    first_calls, warm_sec = bench.run_tighten_apply_full_mode_warm_benchmark(project)

    assert first_calls > 0
    assert warm_sec >= 0.0
