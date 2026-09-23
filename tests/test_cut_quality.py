from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from podcast_mcp.edits.cut_quality import (
    _measure_join_jump_cached,
    assess_cut_risk,
    measure_join_jump_db,
    optimize_and_assess,
    recommend_cut_fade_ms,
)
from podcast_mcp.models import (
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
)


def _minimal_project() -> EpisodeProject:
    project = EpisodeProject.create("risk", "/tmp/ws")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/host.wav", duration_sec=10.0),
        )
    ]
    project.transcripts = [Transcript(track_id="host", words=[])]
    return project


def test_assess_cut_risk_low_filler_asr_confidence():
    project = _minimal_project()
    with patch(
        "podcast_mcp.edits.cut_quality.measure_join_jump_db",
        return_value=2.0,
    ):
        risk = assess_cut_risk(
            project,
            "host",
            1.0,
            1.2,
            filler_confidence=0.05,
            boundary_confidence=0.9,
            defaults={"tighten": {"max_cut_risk_score": 0.65, "min_filler_confidence": 0.15}},
        )
    assert any("filler ASR" in r for r in risk.reasons)


def test_assess_cut_risk_reports_margin_violation():
    project = _minimal_project()
    with (
        patch(
            "podcast_mcp.edits.cut_quality.word_margin_violation_sec",
            return_value=0.05,
        ),
        patch(
            "podcast_mcp.edits.cut_quality.measure_join_jump_db",
            return_value=2.0,
        ),
    ):
        risk = assess_cut_risk(
            project,
            "host",
            1.0,
            1.2,
            boundary_confidence=0.9,
            defaults={"tighten": {"max_cut_risk_score": 0.65}},
        )
    assert any("margin" in r for r in risk.reasons)


def test_assess_cut_risk_only_end_join_harsh():
    project = _minimal_project()
    with patch(
        "podcast_mcp.edits.cut_quality.measure_join_jump_db",
        side_effect=[2.0, 14.0],
    ):
        risk = assess_cut_risk(
            project,
            "host",
            1.0,
            1.2,
            boundary_confidence=0.2,
            defaults={
                "tighten": {"max_cut_risk_score": 0.65},
                "analysis": {"heuristics": {"boundary_jump_db": 12.0}},
            },
        )
    assert any("end" in r for r in risk.reasons)
    assert risk.score > 0.5


def test_recommend_cut_fade_ms_with_only_end_jump():
    project = _minimal_project()
    with patch(
        "podcast_mcp.edits.cut_quality.measure_join_jump_db",
        side_effect=[None, 14.0],
    ):
        fade = recommend_cut_fade_ms(
            project,
            "host",
            1.0,
            1.2,
            defaults={
                "tighten": {"crossfade_ms": 10},
                "analysis": {
                    "heuristics": {
                        "boundary_jump_db": 12.0,
                        "min_fade_ms": 10,
                        "recommended_fade_ms": 30,
                    }
                },
            },
        )
    assert fade >= 30


def test_assess_cut_risk_only_start_join_harsh():
    project = _minimal_project()
    with patch(
        "podcast_mcp.edits.cut_quality.measure_join_jump_db",
        side_effect=[14.0, 2.0],
    ):
        risk = assess_cut_risk(
            project,
            "host",
            1.0,
            1.2,
            boundary_confidence=0.9,
            defaults={
                "tighten": {"max_cut_risk_score": 0.65},
                "analysis": {"heuristics": {"boundary_jump_db": 12.0}},
            },
        )
    assert any("start" in r for r in risk.reasons)


def test_recommend_cut_fade_ms_with_only_start_jump():
    project = _minimal_project()
    with patch(
        "podcast_mcp.edits.cut_quality.measure_join_jump_db",
        side_effect=[14.0, None],
    ):
        fade = recommend_cut_fade_ms(
            project,
            "host",
            1.0,
            1.2,
            defaults={
                "tighten": {"crossfade_ms": 10},
                "analysis": {
                    "heuristics": {
                        "boundary_jump_db": 12.0,
                        "min_fade_ms": 10,
                        "recommended_fade_ms": 30,
                    }
                },
            },
        )
    assert fade >= 30


def test_measure_join_jump_db_reads_track(sample_wav: Path, tmp_path: Path):
    project = _minimal_project()
    raw = tmp_path / "host.wav"
    raw.write_bytes(sample_wav.read_bytes())
    project.tracks[0].media.path = str(raw)
    with patch(
        "podcast_mcp.edits.cut_quality.measure_window_rms_db",
        side_effect=[-20.0, -18.0],
    ):
        jump = measure_join_jump_db(project, "host", 0.5)
    assert jump == pytest.approx(2.0)


def test_recommend_cut_fade_ms_defaults_when_no_jump():
    project = _minimal_project()
    fade = recommend_cut_fade_ms(
        project,
        "host",
        1.0,
        1.2,
        defaults={"tighten": {"crossfade_ms": 25}},
    )
    assert fade >= 10


def test_optimize_and_assess_honors_inaudible_opt_false():
    project = _minimal_project()
    with patch(
        "podcast_mcp.edits.cut_quality.optimize_source_cut_range",
    ) as opt:
        from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

        opt.return_value = OptimizedCutRange(
            start=1.0,
            end=1.2,
            mode="vocal_transcript_guided",
            shifted_start_ms=0.0,
            shifted_end_ms=0.0,
            confidence=0.8,
            details={},
        )
        with patch(
            "podcast_mcp.edits.cut_quality.measure_join_jump_db",
            return_value=2.0,
        ):
            optimize_and_assess(
                project,
                "host",
                1.0,
                1.2,
                defaults={"tighten": {"inaudible_opt": False}},
            )
    assert opt.call_args.kwargs.get("force_enabled") is False


def test_measure_join_jump_db_missing_track():
    project = _minimal_project()
    project.tracks = []
    assert measure_join_jump_db(project, "host", 1.0) is None


def test_assess_cut_risk_short_cut_window():
    project = _minimal_project()
    risk = assess_cut_risk(
        project,
        "host",
        1.0,
        1.01,
        boundary_confidence=0.9,
        defaults={"tighten": {"max_cut_risk_score": 0.65}},
    )
    assert any("short" in r for r in risk.reasons)


def test_assess_cut_risk_flags_harsh_join():
    project = _minimal_project()
    with patch(
        "podcast_mcp.edits.cut_quality.measure_join_jump_db",
        return_value=14.0,
    ):
        risk = assess_cut_risk(
            project,
            "host",
            1.0,
            1.2,
            boundary_confidence=0.2,
            defaults={
                "tighten": {"max_cut_risk_score": 0.65},
                "analysis": {"heuristics": {"boundary_jump_db": 12.0}},
            },
        )
    assert risk.too_risky
    assert any("harsh" in r for r in risk.reasons)


def test_recommend_cut_fade_ms_scales_with_jump():
    project = _minimal_project()
    with patch(
        "podcast_mcp.edits.cut_quality.measure_join_jump_db",
        return_value=15.0,
    ):
        fade = recommend_cut_fade_ms(
            project,
            "host",
            1.0,
            1.2,
            cut_kind="filler",
            defaults={
                "tighten": {"crossfade_ms": 25},
                "analysis": {
                    "heuristics": {
                        "boundary_jump_db": 12.0,
                        "min_fade_ms": 10,
                        "recommended_fade_ms": 30,
                    }
                },
            },
        )
    assert fade >= 30


def test_recommend_post_pad_fade_in_quiet_uses_min():
    from podcast_mcp.edits.cut_quality import recommend_post_pad_fade_in_ms

    project = _minimal_project()
    with patch(
        "podcast_mcp.edits.cut_quality._resume_edge_rms_db",
        return_value=-50.0,
    ):
        fade = recommend_post_pad_fade_in_ms(
            project,
            "host",
            1.0,
            defaults={
                "tighten": {
                    "filler_post_pad_fade_in_min_ms": 15,
                    "filler_post_pad_fade_in_max_ms": 120,
                    "filler_post_pad_quiet_db": -48.0,
                    "filler_post_pad_hot_db": -22.0,
                    "filler_post_pad_look_ahead_ms": 120,
                }
            },
        )
    assert fade == 15


def test_recommend_post_pad_fade_in_covers_late_hot_onset():
    from podcast_mcp.edits.cut_quality import recommend_post_pad_fade_in_ms

    project = _minimal_project()

    def _rms(_project, _tid, _resume, start_off, end_off, **_kw):
        mid = (start_off + end_off) / 2.0
        return -18.0 if mid >= 0.08 else -50.0

    with patch(
        "podcast_mcp.edits.cut_quality._resume_edge_rms_db",
        side_effect=_rms,
    ):
        fade = recommend_post_pad_fade_in_ms(
            project,
            "host",
            436.2,
            defaults={
                "tighten": {
                    "filler_post_pad_fade_in_min_ms": 15,
                    "filler_post_pad_fade_in_max_ms": 120,
                    "filler_post_pad_quiet_db": -48.0,
                    "filler_post_pad_hot_db": -22.0,
                    "filler_post_pad_look_ahead_ms": 120,
                }
            },
        )
    assert fade >= 100
    assert fade <= 120


def test_recommend_prev_word_lead_out_waits_for_quiet():
    from podcast_mcp.edits.cut_quality import recommend_prev_word_lead_out_ms

    project = _minimal_project()

    def _rms(_project, _tid, _resume, start_off, end_off, **_kw):
        mid = (start_off + end_off) / 2.0
        return -28.0 if mid < 0.20 else -45.0

    with patch(
        "podcast_mcp.edits.cut_quality._resume_edge_rms_db",
        side_effect=_rms,
    ):
        out = recommend_prev_word_lead_out_ms(
            project,
            "host",
            435.14,
            defaults={
                "tighten": {
                    "filler_prev_word_lead_out_min_ms": 40,
                    "filler_prev_word_lead_out_max_ms": 250,
                    "filler_prev_word_quiet_db": -42.0,
                    "filler_prev_word_look_ahead_ms": 300,
                }
            },
        )
    assert out >= 200
    assert out <= 250


def test_recommend_prev_word_lead_out_uses_max_when_never_quiet():
    from podcast_mcp.edits.cut_quality import recommend_prev_word_lead_out_ms

    project = _minimal_project()
    with patch(
        "podcast_mcp.edits.cut_quality._resume_edge_rms_db",
        return_value=-20.0,
    ):
        out = recommend_prev_word_lead_out_ms(
            project,
            "host",
            1.0,
            defaults={
                "tighten": {
                    "filler_prev_word_lead_out_min_ms": 40,
                    "filler_prev_word_lead_out_max_ms": 180,
                    "filler_prev_word_quiet_db": -42.0,
                    "filler_prev_word_look_ahead_ms": 100,
                }
            },
        )
    assert out == 180


def test_recommend_prev_word_lead_out_respects_max_available():
    from podcast_mcp.edits.cut_quality import recommend_prev_word_lead_out_ms

    project = _minimal_project()
    calls: list[tuple[float, float]] = []

    def _rms(_project, _tid, _resume, start_off, end_off, **_kw):
        calls.append((start_off, end_off))
        return -50.0

    with patch(
        "podcast_mcp.edits.cut_quality._resume_edge_rms_db",
        side_effect=_rms,
    ):
        out = recommend_prev_word_lead_out_ms(
            project,
            "host",
            1.0,
            max_available_sec=0.05,
            defaults={
                "tighten": {
                    "filler_prev_word_lead_out_min_ms": 40,
                    "filler_prev_word_lead_out_max_ms": 250,
                    "filler_prev_word_quiet_db": -42.0,
                    "filler_prev_word_look_ahead_ms": 300,
                }
            },
        )
    assert out == 40
    assert calls
    assert max(end for _s, end in calls) <= 0.05 + 1e-9


def test_recommend_post_pad_fade_in_swaps_inverted_min_max():
    from podcast_mcp.edits.cut_quality import recommend_post_pad_fade_in_ms

    project = _minimal_project()
    with patch(
        "podcast_mcp.edits.cut_quality._resume_edge_rms_db",
        return_value=-10.0,
    ):
        fade = recommend_post_pad_fade_in_ms(
            project,
            "host",
            1.0,
            defaults={
                "tighten": {
                    "filler_post_pad_fade_in_min_ms": 100,
                    "filler_post_pad_fade_in_max_ms": 20,
                    "filler_post_pad_quiet_db": -48.0,
                    "filler_post_pad_hot_db": -22.0,
                    "filler_post_pad_look_ahead_ms": 40,
                }
            },
        )
    assert 20 <= fade <= 100


def test_recommend_prev_word_lead_out_disabled_when_max_zero():
    from podcast_mcp.edits.cut_quality import recommend_prev_word_lead_out_ms

    project = _minimal_project()
    assert (
        recommend_prev_word_lead_out_ms(
            project,
            "host",
            1.0,
            defaults={
                "tighten": {
                    "filler_prev_word_lead_out_min_ms": 40,
                    "filler_prev_word_lead_out_max_ms": 0,
                }
            },
        )
        == 0
    )


def test_recommend_post_pad_fade_in_disabled_when_max_zero():
    from podcast_mcp.edits.cut_quality import recommend_post_pad_fade_in_ms

    project = _minimal_project()
    assert (
        recommend_post_pad_fade_in_ms(
            project,
            "host",
            1.0,
            defaults={
                "tighten": {
                    "filler_post_pad_fade_in_min_ms": 15,
                    "filler_post_pad_fade_in_max_ms": 0,
                }
            },
        )
        == 0
    )


def test_resume_edge_rms_db_missing_track():
    from podcast_mcp.edits.cut_quality import _resume_edge_rms_db

    project = _minimal_project()
    project.tracks = []
    assert _resume_edge_rms_db(project, "host", 1.0, 0.0, 0.02) is None


def test_recommend_prev_word_lead_out_min_when_no_energy_readings():
    from podcast_mcp.edits.cut_quality import recommend_prev_word_lead_out_ms

    project = _minimal_project()
    with patch(
        "podcast_mcp.edits.cut_quality._resume_edge_rms_db",
        return_value=None,
    ):
        out = recommend_prev_word_lead_out_ms(
            project,
            "host",
            1.0,
            defaults={
                "tighten": {
                    "filler_prev_word_lead_out_min_ms": 55,
                    "filler_prev_word_lead_out_max_ms": 250,
                    "filler_prev_word_look_ahead_ms": 60,
                }
            },
        )
    assert out == 55


def test_assess_cut_risk_safe_when_confident():
    project = _minimal_project()
    with patch(
        "podcast_mcp.edits.cut_quality.measure_join_jump_db",
        return_value=2.0,
    ):
        risk = assess_cut_risk(
            project,
            "host",
            1.0,
            1.2,
            filler_confidence=0.9,
            boundary_confidence=0.9,
            defaults={"tighten": {"max_cut_risk_score": 0.65}},
        )
    assert not risk.too_risky


def test_measure_join_jump_cached_reuses_value_within_one_cache():
    project = _minimal_project()
    cache: dict = {}
    with patch(
        "podcast_mcp.edits.cut_quality.measure_join_jump_db",
        return_value=7.5,
    ) as measure:
        first = _measure_join_jump_cached(project, "host", 1.0, cache)
        second = _measure_join_jump_cached(project, "host", 1.0, cache)
    assert first == second == 7.5
    measure.assert_called_once_with(project, "host", 1.0, audio_cache=None)


def test_measure_join_jump_cached_distinguishes_by_track_and_time():
    project = _minimal_project()
    cache: dict = {}
    with patch(
        "podcast_mcp.edits.cut_quality.measure_join_jump_db",
        side_effect=[1.0, 2.0, 3.0],
    ) as measure:
        _measure_join_jump_cached(project, "host", 1.0, cache)
        _measure_join_jump_cached(project, "host", 1.2, cache)
        _measure_join_jump_cached(project, "guest", 1.0, cache)
    assert measure.call_count == 3


def test_measure_join_jump_cached_no_cache_always_calls_through():
    project = _minimal_project()
    with patch(
        "podcast_mcp.edits.cut_quality.measure_join_jump_db",
        return_value=4.0,
    ) as measure:
        _measure_join_jump_cached(project, "host", 1.0, None)
        _measure_join_jump_cached(project, "host", 1.0, None)
    assert measure.call_count == 2


def test_optimize_and_assess_shares_jump_cache_with_fade_recommendation():
    """assess_cut_risk (inside optimize_and_assess) and recommend_cut_fade_ms both
    measure the join jump at the same boundaries -- passing one cache to both should
    only hit measure_join_jump_db twice total (once per boundary), not four times.
    """
    project = _minimal_project()
    with (
        patch(
            "podcast_mcp.edits.cut_quality.optimize_source_cut_range",
        ) as opt,
        patch(
            "podcast_mcp.edits.cut_quality.measure_join_jump_db",
            return_value=2.0,
        ) as measure,
    ):
        from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

        opt.return_value = OptimizedCutRange(
            start=1.0,
            end=1.2,
            mode="vocal_transcript_guided",
            shifted_start_ms=0.0,
            shifted_end_ms=0.0,
            confidence=0.8,
            details={},
        )
        cache: dict = {}
        result, _risk = optimize_and_assess(project, "host", 1.0, 1.2, cache=cache)
        recommend_cut_fade_ms(
            project, "host", result.start, result.end, cut_kind="filler", cache=cache
        )
    assert measure.call_count == 2
