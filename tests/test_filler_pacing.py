"""Tests for filler pacing (min gap + room-tone replace)."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from podcast_mcp.edits.decisions import approve_edits
from podcast_mcp.edits.filler_pacing import (
    apply_filler_pacing,
    expand_cut_for_room_tone_replace,
    flanking_retained_words,
    shrink_cut_for_min_gap,
)
from podcast_mcp.edits.fillers import analyze_fillers_and_pauses
from podcast_mcp.edits.timeline_ops import insert_room_tone_pad
from podcast_mcp.edits.transcript_cuts import cut_time_range
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


def _project(
    words: list[TranscriptWord],
    *,
    duration: float = 30.0,
) -> EpisodeProject:
    project = EpisodeProject.create("pacing", "/tmp/ws")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/host.wav", duration_sec=duration),
        )
    ]
    project.clips = [
        Clip(
            id="c1",
            track_id="host",
            source_start=0.0,
            source_end=duration,
            timeline_start=0.0,
        )
    ]
    project.transcripts = [Transcript(track_id="host", words=words)]
    return project


def test_shrink_cut_for_min_gap_shrinks_excess():
    # Gap 1.0s (0.5→1.5); cut 0.9s inside gap would leave 0.1 - shrink to leave 0.28
    out = shrink_cut_for_min_gap(0.55, 1.45, 0.5, 1.5, 0.28)
    assert out is not None
    start, end = out
    assert (1.5 - 0.5) - (end - start) == pytest.approx(0.28)
    assert end - start == pytest.approx(0.72)


def test_shrink_cut_clamp_vanishes():
    # After shrink+clamp the window collapses below min_cut_sec
    out = shrink_cut_for_min_gap(0.9, 1.6, 1.0, 1.05, 0.28, min_cut_sec=0.05)
    assert out is None


def test_apply_filler_pacing_shrink_skips_tight_gap():
    words = [
        TranscriptWord(text="And", start=1.0, end=1.2),
        TranscriptWord(text="um", start=1.25, end=1.4),
        TranscriptWord(text="really", start=1.45, end=1.6),
    ]
    project = _project(words)
    paced = apply_filler_pacing(
        project,
        "host",
        1.25,
        1.4,
        defaults={
            "tighten": {
                "min_gap_after_filler_sec": 0.28,
                "filler_room_tone_replace": False,
            }
        },
        cut_kind="filler",
    )
    assert paced is None


def test_room_tone_source_span_edge_cases():
    from podcast_mcp.edits.timeline_ops import _room_tone_source_span

    project = _project([TranscriptWord(text="hi", start=0.0, end=0.2)], duration=5.0)
    left = project.clips[0]
    assert _room_tone_source_span(project, "host", left, duration_sec=0) is None
    project.tracks[0].media = None
    assert _room_tone_source_span(project, "host", left, duration_sec=0.2) is None


def test_insert_room_tone_pad_tiles_short_sample():
    p = _project([TranscriptWord(text="hi", start=0.0, end=0.1)], duration=10.0)
    p.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=0.15,  # short left clip → short sample
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=1.0,
            source_end=5.0,
            timeline_start=0.15,
        ),
    ]
    insert_room_tone_pad(p, 0.15, 0.4, sample_duration_sec=0.1)
    host = sorted([c for c in p.clips if c.track_id == "host"], key=lambda c: c.timeline_start)
    # Multiple pad tiles between left and shifted right
    assert len(host) >= 4


def test_insert_room_tone_pad_skips_track_without_left_clip():
    p = _project([TranscriptWord(text="hi", start=0.0, end=0.5)], duration=5.0)
    p.tracks.append(
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/ws/raw/guest.wav", duration_sec=5.0),
        )
    )
    # Only host has clips; guest has none → pad still succeeds for host
    p.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=2.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=2.0, source_end=5.0, timeline_start=2.0),
    ]
    summary = insert_room_tone_pad(p, 2.0, 0.2)
    assert summary["operation"] == "insert_room_tone_pad"


def test_update_pending_edit_rejects_inverted_range():
    from podcast_mcp.edits.decisions import update_pending_edit

    project = _project([TranscriptWord(text="um", start=1.0, end=1.2)])
    project.edit_decisions = [
        EditDecision(
            id="cut_1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=1.2,
            review_required=True,
            applied=False,
        )
    ]
    with pytest.raises(ValueError):
        update_pending_edit(project, "cut_1", start=2.0, end=1.0)


def test_shrink_cut_invalid_inputs():
    assert shrink_cut_for_min_gap(1.5, 1.2, 0.5, 2.0, 0.28) is None
    assert shrink_cut_for_min_gap(1.0, 1.2, 2.0, 1.0, 0.28) is None
    assert shrink_cut_for_min_gap(1.0, 1.05, 1.0, 1.1, 0.28) is None


def test_expand_cut_too_tight():
    assert (
        expand_cut_for_room_tone_replace(1.0, 1.01, start_margin_sec=0.01, end_margin_sec=0.01)
        is None
    )


def test_apply_filler_pacing_pause_noop():
    project = _project([TranscriptWord(text="hi", start=0.0, end=0.5)])
    paced = apply_filler_pacing(
        project, "host", 1.0, 2.0, cut_kind="pause", defaults={"tighten": {}}
    )
    assert paced is not None
    assert paced.start == 1.0 and paced.end == 2.0


def test_apply_filler_pacing_min_gap_disabled():
    words = [
        TranscriptWord(text="And", start=1.0, end=1.2),
        TranscriptWord(text="um", start=1.5, end=1.7),
        TranscriptWord(text="really", start=2.5, end=2.8),
    ]
    project = _project(words)
    paced = apply_filler_pacing(
        project,
        "host",
        1.5,
        1.7,
        defaults={"tighten": {"min_gap_after_filler_sec": 0}},
        cut_kind="filler",
    )
    assert paced is not None
    assert paced.start == 1.5 and paced.end == 1.7
    assert paced.replace_gap_sec is None


def test_apply_filler_pacing_no_flanking_words():
    project = _project([TranscriptWord(text="um", start=1.0, end=1.2)])
    paced = apply_filler_pacing(
        project,
        "host",
        1.0,
        1.2,
        defaults={
            "tighten": {
                "min_gap_after_filler_sec": 0.28,
                "filler_room_tone_replace": True,
            }
        },
        cut_kind="filler",
    )
    assert paced is not None
    assert paced.replace_gap_sec is None


def test_apply_filler_pacing_invalid_range():
    project = _project(
        [
            TranscriptWord(text="a", start=0.0, end=0.2),
            TranscriptWord(text="b", start=1.0, end=1.2),
        ]
    )
    assert (
        apply_filler_pacing(project, "host", 1.0, 1.0, defaults={"tighten": {}}, cut_kind="nl")
        is None
    )


def test_flanking_includes_suppressed_as_timing_anchors():
    words = [
        TranscriptWord(text="And", start=1.0, end=1.2),
        TranscriptWord(text="noise", start=1.25, end=1.4, suppressed=True),
        TranscriptWord(text="um", start=1.5, end=1.7),
        TranscriptWord(text="really", start=2.5, end=2.8),
    ]
    project = _project(words)
    prev, nxt = flanking_retained_words(project, "host", 1.5, 1.7)
    assert prev is not None and prev.text == "noise"
    assert nxt is not None and nxt.text == "really"


def test_room_tone_expand_falls_back_when_gap_huge():
    words = [
        TranscriptWord(text="now", start=0.0, end=1.0),
        TranscriptWord(text="um", start=10.0, end=10.2),
        TranscriptWord(text="later", start=20.0, end=21.0),
    ]
    project = _project(words)
    paced = apply_filler_pacing(
        project,
        "host",
        10.0,
        10.2,
        defaults={
            "tighten": {
                "min_gap_after_filler_sec": 0.28,
                "filler_room_tone_replace": True,
                "filler_room_tone_max_expand_sec": 2.0,
            },
            "inaudible_cuts": {"min_word_margin_ms": 5},
        },
        cut_kind="filler",
    )
    assert paced is not None
    # Keep local um bounds instead of expanding across the 19s gap
    assert paced.start == pytest.approx(10.0)
    assert paced.end == pytest.approx(10.2)
    assert paced.replace_gap_sec == pytest.approx(0.28)


def test_apply_auto_edits_with_room_tone_pads():
    from podcast_mcp.edits.decisions import apply_auto_edits

    words = [
        TranscriptWord(text="And", start=1.0, end=1.2),
        TranscriptWord(text="um", start=1.5, end=1.7),
        TranscriptWord(text="really", start=2.5, end=2.8),
    ]
    project = _project(words, duration=10.0)
    project.edit_decisions = [
        EditDecision(
            id="f1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.205,
            end=2.495,
            review_required=False,
            applied=False,
            replace_gap_sec=0.28,
            reason="filler:um",
        )
    ]
    with (
        patch(
            "podcast_mcp.edits.decisions.load_defaults",
            return_value={
                "tighten": {
                    "inaudible_opt": False,
                    "filler_pre_pad_fade_out_ms": 5,
                    "filler_post_pad_fade_in_min_ms": 15,
                    "filler_post_pad_fade_in_max_ms": 120,
                },
                "render": {"join_fade_max_ms": 15},
            },
        ),
        patch(
            "podcast_mcp.edits.decisions.recommend_post_pad_fade_in_ms",
            return_value=72,
        ),
    ):
        n = apply_auto_edits(project)
    assert n == 1
    assert project.edit_decisions == []
    host = sorted(
        (c for c in project.clips if c.track_id == "host"),
        key=lambda c: c.timeline_start,
    )
    assert len(host) >= 2
    # Pad opens a hole: left gets tiny declick, right gets adaptive resume fade.
    assert host[0].fade_out_ms == 5
    assert host[1].fade_in_ms >= 72


def test_insert_room_tone_pad_rejects_nonpositive():
    p = _project([TranscriptWord(text="hi", start=0.0, end=0.5)])
    with pytest.raises(ValueError):
        insert_room_tone_pad(p, 1.0, 0.0)


def test_cut_time_range_raises_when_gap_too_tight():
    words = [
        TranscriptWord(text="And", start=1.0, end=1.05),
        TranscriptWord(text="um", start=1.052, end=1.055),
        TranscriptWord(text="really", start=1.06, end=1.2),
    ]
    project = _project(words)

    def passthrough(project, track_id, start, end, force_enabled=None):
        from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

        return OptimizedCutRange(
            start=start,
            end=end,
            mode="vocal_transcript_guided",
            shifted_start_ms=0.0,
            shifted_end_ms=0.0,
            confidence=0.9,
            details={},
        )

    with (
        patch(
            "podcast_mcp.edits.transcript_cuts.optimize_source_cut_range",
            side_effect=passthrough,
        ),
        pytest.raises(ValueError, match="min_gap_after_filler"),
    ):
        cut_time_range(
            project,
            "host",
            1.052,
            1.055,
            defaults={
                "tighten": {
                    "min_gap_after_filler_sec": 0.28,
                    "filler_room_tone_replace": True,
                },
                "inaudible_cuts": {"min_word_margin_ms": 5},
            },
        )


def test_shrink_cut_skips_when_floor_consumes_gap():
    assert shrink_cut_for_min_gap(1.0, 1.2, 1.0, 1.25, 0.28) is None


def test_expand_cut_for_room_tone_replace():
    out = expand_cut_for_room_tone_replace(1.0, 2.0, start_margin_sec=0.01, end_margin_sec=0.01)
    assert out == pytest.approx((1.01, 1.99))


def test_apply_filler_pacing_room_tone_expand():
    words = [
        TranscriptWord(text="And", start=1.0, end=1.2),
        TranscriptWord(text="um", start=1.5, end=1.7),
        TranscriptWord(text="really", start=2.5, end=2.8),
    ]
    project = _project(words)
    paced = apply_filler_pacing(
        project,
        "host",
        1.5,
        1.7,
        defaults={
            "tighten": {
                "min_gap_after_filler_sec": 0.35,
                "filler_gap_retain_fraction": 0.85,
                "filler_replace_gap_max_sec": 1.0,
                "filler_next_word_lead_in_ms": 80,
                "filler_prev_word_lead_out_ms": 60,
                "filler_room_tone_replace": True,
            },
            "inaudible_cuts": {"min_word_margin_ms": 5},
        },
        cut_kind="filler",
    )
    assert paced is not None
    # Inter-word gap 1.3s x 0.85 retain = 1.105 → capped at 1.0.
    assert paced.replace_gap_sec == pytest.approx(1.0)
    # 60ms lead-out after "And" (air after prev is 0.3s ≥ 40ms).
    assert paced.start == pytest.approx(1.26)
    # 80ms lead-in before "really" (air before next is 0.8s ≥ 40ms).
    assert paced.end == pytest.approx(2.42)
    assert paced.allow_trailing_past_end is False


def test_apply_filler_pacing_overlap_allows_trailing_past():
    """When next ASR token abuts the filler, keep tight end margin + trailing ok."""
    words = [
        TranscriptWord(text="funny", start=1.0, end=1.2),
        TranscriptWord(text="um", start=1.2, end=1.5),
        TranscriptWord(text="you", start=1.5, end=1.7),
        TranscriptWord(text="know", start=1.7, end=1.9),
    ]
    project = _project(words)
    paced = apply_filler_pacing(
        project,
        "host",
        1.2,
        1.5,
        defaults={
            "tighten": {
                "min_gap_after_filler_sec": 0.35,
                "filler_room_tone_replace": True,
                "filler_next_word_lead_in_ms": 80,
                "filler_prev_word_lead_out_ms": 60,
            },
            "inaudible_cuts": {"min_word_margin_ms": 5},
        },
        cut_kind="nl",
    )
    assert paced is not None
    assert paced.allow_trailing_past_end is True
    # Tight margin only (you starts at cut end; prev also abuts um).
    assert paced.start == pytest.approx(1.2 + 0.005)
    assert paced.end == pytest.approx(1.5 - 0.005)


def test_replace_gap_retains_fraction_of_original():
    from podcast_mcp.edits.filler_pacing import replace_gap_for_hesitation

    defaults = {
        "tighten": {
            "min_gap_after_filler_sec": 0.35,
            "filler_gap_retain_fraction": 0.85,
            "filler_replace_gap_max_sec": 1.0,
        }
    }
    # Short um gap floors at min_gap.
    assert replace_gap_for_hesitation(
        inter_word_gap_sec=0.40, cut_dur_sec=0.25, defaults=defaults
    ) == pytest.approx(0.35)
    # Longer "you know" keeps most of the thought-boundary air.
    assert replace_gap_for_hesitation(
        inter_word_gap_sec=1.14, cut_dur_sec=0.72, defaults=defaults
    ) == pytest.approx(0.969)
    # Cap long gaps.
    assert replace_gap_for_hesitation(
        inter_word_gap_sec=2.0, cut_dur_sec=0.5, defaults=defaults
    ) == pytest.approx(1.0)


def test_apply_filler_pacing_shrink_mode():
    words = [
        TranscriptWord(text="And", start=1.0, end=1.2),
        TranscriptWord(text="um", start=1.3, end=2.0),
        TranscriptWord(text="really", start=2.1, end=2.4),
    ]
    project = _project(words)
    paced = apply_filler_pacing(
        project,
        "host",
        1.3,
        2.0,
        defaults={
            "tighten": {
                "min_gap_after_filler_sec": 0.28,
                "filler_room_tone_replace": False,
            }
        },
        cut_kind="filler",
    )
    assert paced is not None
    assert paced.replace_gap_sec is None
    # original gap 0.9; max remove 0.62; cut was 0.7 → shrink
    assert paced.end - paced.start == pytest.approx(0.62)
    prev, nxt = flanking_retained_words(project, "host", paced.start, paced.end)
    assert prev is not None and nxt is not None
    remaining = (paced.start - prev.end) + (nxt.start - paced.end)
    assert remaining == pytest.approx(0.28)


def test_analyze_fillers_sets_replace_gap(monkeypatch):
    words = [
        TranscriptWord(text="hello", start=0.0, end=0.4, confidence=0.9),
        TranscriptWord(text="um", start=0.5, end=0.7, confidence=0.9),
        TranscriptWord(text="uh", start=0.75, end=0.95, confidence=0.85),
        TranscriptWord(text="world", start=2.0, end=2.4, confidence=0.95),
    ]
    project = _project(words)
    from podcast_mcp.edits.cut_quality import CutRisk
    from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

    def fake_opt(project, track_id, start, end, **kw):
        return (
            OptimizedCutRange(
                start=start,
                end=end,
                mode="vocal_transcript_guided",
                shifted_start_ms=0.0,
                shifted_end_ms=0.0,
                confidence=0.9,
                details={},
            ),
            CutRisk(score=0.1, reasons=[]),
        )

    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", side_effect=fake_opt),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=25),
    ):
        defaults = {
            "tighten": {
                "filler_words": ["um", "uh"],
                "max_pause_sec": 99.0,
                "min_filler_cluster": 2,
                "min_gap_after_filler_sec": 0.28,
                "filler_room_tone_replace": True,
            },
            "inaudible_cuts": {"min_word_margin_ms": 5},
        }
        analyze_fillers_and_pauses(project, project.transcripts[0], defaults)
    assert project.edit_decisions
    assert any(
        d.replace_gap_sec is not None and d.replace_gap_sec >= 0.28 for d in project.edit_decisions
    )


def test_insert_room_tone_pad_fills_gap():
    p = _project(
        [TranscriptWord(text="hi", start=0.0, end=0.5)],
        duration=10.0,
    )
    # Split into two clips with a join at 3.0 after we insert pad there
    p.clips = [
        Clip(
            id="a",
            track_id="host",
            source_start=0.0,
            source_end=3.0,
            timeline_start=0.0,
        ),
        Clip(
            id="b",
            track_id="host",
            source_start=3.0,
            source_end=10.0,
            timeline_start=3.0,
        ),
    ]
    summary = insert_room_tone_pad(p, 3.0, 0.28)
    assert summary["operation"] == "insert_room_tone_pad"
    host = sorted([c for c in p.clips if c.track_id == "host"], key=lambda c: c.timeline_start)
    assert len(host) >= 3
    # Pad occupies [3.0, 3.28); following clip shifted
    assert host[-1].timeline_start == pytest.approx(3.28)


def test_filler_pad_mode_defaults_to_silence():
    from podcast_mcp.edits.filler_pacing import filler_pad_mode

    assert filler_pad_mode({}) == "silence"
    assert filler_pad_mode({"tighten": {}}) == "silence"
    assert filler_pad_mode({"tighten": {"filler_pad_mode": "room_tone"}}) == "room_tone"
    assert filler_pad_mode({"tighten": {"filler_pad_mode": "SILENCE"}}) == "silence"


def test_approve_edits_applies_silence_pad_by_default():
    words = [
        TranscriptWord(text="And", start=1.0, end=1.2),
        TranscriptWord(text="um", start=1.5, end=1.7),
        TranscriptWord(text="really", start=2.5, end=2.8),
    ]
    project = _project(words, duration=10.0)
    project.edit_decisions = [
        EditDecision(
            id="cut_1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.205,
            end=2.495,
            review_required=True,
            applied=False,
            replace_gap_sec=0.28,
            reason="nl:range",
        )
    ]
    before_dur = project.clips[0].timeline_end
    with patch(
        "podcast_mcp.edits.decisions.filler_pad_mode",
        return_value="silence",
    ):
        removed = approve_edits(project, ["cut_1"])
    assert removed == 1
    assert project.edit_decisions == []
    host = sorted(
        [c for c in project.clips if c.track_id == "host"], key=lambda c: c.timeline_start
    )
    # Ripple removed ~1.29s then silence gap added 0.28s (no fill clips).
    assert abs(host[-1].timeline_end - (before_dur - (2.495 - 1.205) + 0.28)) < 0.05
    assert len(host) == 2
    assert host[1].timeline_start - host[0].timeline_end == pytest.approx(0.28)


def test_approve_edits_applies_room_tone_pad_when_configured():
    words = [
        TranscriptWord(text="And", start=1.0, end=1.2),
        TranscriptWord(text="um", start=1.5, end=1.7),
        TranscriptWord(text="really", start=2.5, end=2.8),
    ]
    project = _project(words, duration=10.0)
    project.edit_decisions = [
        EditDecision(
            id="cut_1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.205,
            end=2.495,
            review_required=True,
            applied=False,
            replace_gap_sec=0.28,
            reason="nl:range",
        )
    ]
    with patch(
        "podcast_mcp.edits.decisions.filler_pad_mode",
        return_value="room_tone",
    ):
        removed = approve_edits(project, ["cut_1"])
    assert removed == 1
    host = sorted(
        [c for c in project.clips if c.track_id == "host"], key=lambda c: c.timeline_start
    )
    assert len(host) >= 3
    assert any(0.05 < (c.timeline_end - c.timeline_start) <= 0.28 + 1e-6 for c in host)


def test_cut_time_range_applies_pacing(monkeypatch):
    words = [
        TranscriptWord(text="And", start=1.0, end=1.2),
        TranscriptWord(text="um", start=1.5, end=1.7),
        TranscriptWord(text="really", start=2.5, end=2.8),
    ]
    project = _project(words)

    def passthrough(project, track_id, start, end, force_enabled=None):
        from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

        return OptimizedCutRange(
            start=start,
            end=end,
            mode="vocal_transcript_guided",
            shifted_start_ms=0.0,
            shifted_end_ms=0.0,
            confidence=0.9,
            details={},
        )

    with patch(
        "podcast_mcp.edits.transcript_cuts.optimize_source_cut_range",
        side_effect=passthrough,
    ):
        d = cut_time_range(
            project,
            "host",
            1.5,
            1.7,
            defaults={
                "tighten": {
                    "min_gap_after_filler_sec": 0.28,
                    "filler_room_tone_replace": True,
                },
                "inaudible_cuts": {"min_word_margin_ms": 5},
            },
        )
    assert d.replace_gap_sec == pytest.approx(1.0)
    assert d.end - d.start > 0.9  # expanded across hesitation


def test_clips_cli_approve_and_export_paths(tmp_path, monkeypatch):
    """Cover previously untested clips approve/export CLI handlers."""
    from typer.testing import CliRunner

    from podcast_mcp.cli.clips import clips_app

    project = tmp_path / "episode.project.json"
    project.write_text("{}")

    class FakeWS:
        @staticmethod
        def open(path):
            return object()

    class FakeClipService:
        def __init__(self, ws):
            self.ws = ws

        def approve(self, ids):
            assert ids == ["a", "b"]

        def export(self, ids):
            if ids == ["bad"]:
                raise ValueError("nope")
            return [{"id": "a", "path": "/tmp/a.wav"}]

    monkeypatch.setattr("podcast_mcp.cli.clips.ProjectWorkspace", FakeWS)
    monkeypatch.setattr("podcast_mcp.cli.clips.ClipService", FakeClipService)
    runner = CliRunner()
    r = runner.invoke(clips_app, ["approve", "--project", str(project), "--ids", "a,b"])
    assert r.exit_code == 0
    assert "Approved" in r.stdout
    r = runner.invoke(clips_app, ["export", "--project", str(project), "--ids", "a"])
    assert r.exit_code == 0
    assert "a.wav" in r.stdout
    r = runner.invoke(clips_app, ["export", "--project", str(project), "--ids", "bad"])
    assert r.exit_code == 1


def test_session_parse_selection_and_tool(monkeypatch, tmp_path):
    from podcast_mcp.mcp.tools import session as sess

    assert sess._parse_selection(None) is None
    assert sess._parse_selection("") is None
    assert sess._parse_selection("null") is None
    assert sess._parse_selection('{"kind":"clip"}') == {"kind": "clip"}
    try:
        sess._parse_selection("[1]")
        raise AssertionError("expected ValueError")
    except ValueError:
        pass

    class FakeCtrl:
        def __init__(self, ws):
            pass

        def set_selection(self, selection):
            return {"selection": selection}

    monkeypatch.setattr(
        sess, "ProjectWorkspace", type("W", (), {"open": staticmethod(lambda p: object())})
    )
    monkeypatch.setattr(sess, "SessionControlService", FakeCtrl)
    out = sess.set_session_selection_tool(str(tmp_path), '{"kind":"region"}')
    assert "region" in out


def test_audition_summary_with_comments_and_warnings():
    from podcast_mcp.edits.audition_context import _summary

    s = _summary(
        [{"track_id": "h", "text": "hi", "effects": []}],
        ["w"],
        [{"id": "c"}],
    )
    assert "1 comments" in s and "1 warnings" in s


def test_play_cli_requires_project(monkeypatch):
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    runner = CliRunner()
    r = runner.invoke(app, ["play", "--start", "0", "--end", "1"])
    assert r.exit_code != 0


def test_play_cli_paths_cover_misses(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from typer.testing import CliRunner

    from podcast_mcp.cli.play import play_app

    project = tmp_path / "episode.project.json"
    project.write_text("{}")

    class FakeWS:
        @staticmethod
        def open(path):
            return object()

    class FakePlay:
        def __init__(self, ws):
            pass

        def play(self, req, dry_run=False, player=None):
            return SimpleNamespace(
                wav_path=tmp_path / "x.wav",
                source_label="premix",
                tier="premix",
                start_sec=0.0,
                end_sec=10.0,
                player_cmd=["afplay"],
                compare_segments=[{"track": "host"}],
            )

        def audition_context(self, start, end, skew_warn_sec=0.05, detail="summary"):
            return {"ok": True, "start": start, "end": end, "detail": detail}

    monkeypatch.setattr("podcast_mcp.cli.play.ProjectWorkspace", FakeWS)
    monkeypatch.setattr("podcast_mcp.cli.play.PlayService", FakePlay)
    runner = CliRunner()
    # query path with missing end → defaults
    r = runner.invoke(
        play_app,
        ["--project", str(project), "--query", "hello", "--dry-run"],
    )
    assert r.exit_code == 0
    assert "compare_segments" in r.stdout
    # missing start/end without query
    r = runner.invoke(play_app, ["--project", str(project)])
    assert r.exit_code != 0
    # context subcommand
    r = runner.invoke(
        play_app,
        ["context", "--project", str(project), "--start", "1", "--end", "2", "--detail", "full"],
    )
    assert r.exit_code == 0
    assert (
        '"ok": true' in r.stdout.lower()
        or '"ok": true' in r.stdout
        or '"ok": True' in r.stdout
        or '"ok"' in r.stdout
    )


def test_filler_analysis_skips_bleed_labeled_span() -> None:
    from podcast_mcp.edits.fillers import _cut_span_is_bleed_not_owner

    words = [
        TranscriptWord(
            text="um",
            start=1.0,
            end=1.3,
            audibility_status="bleed",
            speaker_match_track="guest",
        )
    ]
    project = _project(words)
    assert _cut_span_is_bleed_not_owner(project, "host", 1.0, 1.3) is True


def test_cut_span_bleed_swallows_profile_errors() -> None:
    from podcast_mcp.edits.fillers import _cut_span_is_bleed_not_owner

    project = _project([])
    with patch(
        "podcast_mcp.engines.speaker_id.load_all_profiles",
        side_effect=RuntimeError("nope"),
    ):
        assert _cut_span_is_bleed_not_owner(project, "host", 1.0, 1.3) is False


def test_cut_span_uses_speaker_role_when_profiles_exist() -> None:
    from podcast_mcp.edits.fillers import _cut_span_is_bleed_not_owner

    project = _project([])
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={"host": object()},
        ),
        patch(
            "podcast_mcp.engines.speaker_id.assess_speaker_cut_role",
            return_value={"role": "bleed"},
        ),
    ):
        assert _cut_span_is_bleed_not_owner(project, "host", 1.0, 1.3) is True


def test_analyze_candidate_returns_none_for_bleed_span() -> None:
    from podcast_mcp.config import load_defaults
    from podcast_mcp.edits.fillers import _analyze_candidate, _CutCandidate

    words = [
        TranscriptWord(
            text="um",
            start=1.0,
            end=1.3,
            confidence=0.95,
            audibility_status="bleed",
        )
    ]
    project = _project(words)
    candidate = _CutCandidate(
        track_id="host",
        start=1.0,
        end=1.3,
        reason="filler:um",
        cut_kind="filler",
        filler_confidence=0.9,
    )
    defaults = load_defaults()
    defaults.setdefault("inaudible_cuts", {})["enabled"] = False
    opt = type("O", (), {"start": 1.0, "end": 1.3})()
    risk = type("R", (), {"too_risky": False})()
    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", return_value=(opt, risk)),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
    ):
        assert _analyze_candidate(project, candidate, defaults) is None


def test_analyze_candidate_skip_on_guard_value_error() -> None:
    from podcast_mcp.config import load_defaults
    from podcast_mcp.edits.fillers import _analyze_candidate, _CutCandidate

    words = [
        TranscriptWord(text="um", start=1.0, end=1.3, confidence=0.95),
        TranscriptWord(text="ok", start=2.0, end=2.3, confidence=0.95),
    ]
    project = _project(words)
    candidate = _CutCandidate(
        track_id="host",
        start=1.0,
        end=1.3,
        reason="filler:um",
        cut_kind="filler",
        filler_confidence=0.9,
    )
    defaults = load_defaults()
    defaults.setdefault("inaudible_cuts", {})["enabled"] = False
    opt = type("O", (), {"start": 1.0, "end": 1.3})()
    risk = type("R", (), {"too_risky": False})()
    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", return_value=(opt, risk)),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=type("P", (), {"start": 1.0, "end": 1.3, "replace_gap_sec": 0.1})(),
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            side_effect=ValueError("blocked"),
        ),
    ):
        assert _analyze_candidate(project, candidate, defaults) is None


def test_analyze_candidate_marks_review_when_guard_requests() -> None:
    from podcast_mcp.config import load_defaults
    from podcast_mcp.edits.fillers import _analyze_candidate, _CutCandidate
    from podcast_mcp.edits.speech_energy_guard import SpeechEnergyGuardResult

    words = [
        TranscriptWord(text="um", start=1.0, end=1.3, confidence=0.95),
        TranscriptWord(text="ok", start=2.0, end=2.3, confidence=0.95),
    ]
    project = _project(words)
    candidate = _CutCandidate(
        track_id="host",
        start=1.0,
        end=1.3,
        reason="filler:um",
        cut_kind="filler",
        filler_confidence=0.9,
    )
    defaults = load_defaults()
    defaults.setdefault("inaudible_cuts", {})["enabled"] = False
    opt = type("O", (), {"start": 1.0, "end": 1.3, "confidence": 0.9, "mode": "exact"})()
    risk = type("R", (), {"too_risky": False})()
    guard = SpeechEnergyGuardResult(
        blocking_track_ids=("guest",),
        action="review",
    )
    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", return_value=(opt, risk)),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=type("P", (), {"start": 1.0, "end": 1.3, "replace_gap_sec": 0.1})(),
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=("session", guard),
        ),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=10),
    ):
        analyzed = _analyze_candidate(project, candidate, defaults)
    assert analyzed is not None
    assert analyzed.review_required is True
    assert "other_speaking" in analyzed.reason


def test_analyze_candidate_track_local_on_blocked_peer() -> None:
    from podcast_mcp.config import load_defaults
    from podcast_mcp.edits.fillers import _analyze_candidate, _CutCandidate
    from podcast_mcp.edits.speech_energy_guard import SpeechEnergyGuardResult

    project = _project(
        [
            TranscriptWord(text="um", start=1.0, end=1.3, confidence=0.95),
            TranscriptWord(text="ok", start=2.0, end=2.3, confidence=0.95),
        ]
    )
    candidate = _CutCandidate(
        track_id="host",
        start=1.0,
        end=1.3,
        reason="filler:um",
        cut_kind="filler",
        filler_confidence=0.9,
    )
    defaults = load_defaults()
    defaults.setdefault("inaudible_cuts", {})["enabled"] = False
    opt = type("O", (), {"start": 1.0, "end": 1.3, "confidence": 0.9, "mode": "exact"})()
    risk = type("R", (), {"too_risky": False})()
    guard = SpeechEnergyGuardResult(
        blocking_track_ids=("guest",),
        action="track_local",
    )
    with (
        patch("podcast_mcp.edits.fillers.optimize_and_assess", return_value=(opt, risk)),
        patch("podcast_mcp.edits.fillers.detect_adjacent_breath", return_value=[]),
        patch(
            "podcast_mcp.edits.fillers.apply_filler_pacing",
            return_value=type("P", (), {"start": 1.0, "end": 1.3, "replace_gap_sec": 0.1})(),
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.resolve_cut_scope",
            return_value=("session", guard),
        ),
        patch("podcast_mcp.edits.fillers.recommend_cut_fade_ms", return_value=10),
    ):
        analyzed = _analyze_candidate(project, candidate, defaults)
    assert analyzed is not None
    assert analyzed.scope == "track"
    assert analyzed.replace_gap_sec is None
    assert "track_local" in analyzed.reason
