"""Speech-energy guard and track-local punch."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from podcast_mcp.edits.clips_ops import clips_for_track, punch_timeline_range_from_clips
from podcast_mcp.edits.decisions import approve_edits
from podcast_mcp.edits.speech_energy_guard import (
    assess_cross_track_speech,
    resolve_cut_scope,
)
from podcast_mcp.edits.timeline_ops import punch_delete
from podcast_mcp.edits.transcript_cuts import add_remove_decision
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


def _two_track(
    *,
    duration: float = 10.0,
    host_words: list[TranscriptWord] | None = None,
    guest_words: list[TranscriptWord] | None = None,
) -> EpisodeProject:
    p = EpisodeProject.create("seg", "/tmp/seg")
    p.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/seg/raw/host.wav", duration_sec=duration),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="/tmp/seg/raw/guest.wav", duration_sec=duration),
        ),
    ]
    p.clips = [
        Clip(
            id="h1",
            track_id="host",
            source_start=0.0,
            source_end=duration,
            timeline_start=0.0,
        ),
        Clip(
            id="g1",
            track_id="guest",
            source_start=0.0,
            source_end=duration,
            timeline_start=0.0,
        ),
    ]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=host_words
            or [
                TranscriptWord(text="um", start=2.0, end=2.5),
            ],
        ),
        Transcript(
            track_id="guest",
            words=guest_words
            or [
                TranscriptWord(text="And", start=1.8, end=2.0),
            ],
        ),
    ]
    return p


def test_punch_timeline_range_leaves_hole_without_shift():
    clips = [
        Clip(
            id="c",
            track_id="host",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        )
    ]
    out = punch_timeline_range_from_clips(clips, 2.0, 2.5)
    assert len(out) == 2
    assert out[0].timeline_end == pytest.approx(2.0)
    assert out[1].timeline_start == pytest.approx(2.5)
    assert out[1].source_start == pytest.approx(2.5)
    # No ripple: right clip still ends at original timeline end
    assert out[1].timeline_end == pytest.approx(10.0)


def test_assess_blocks_when_other_track_hot():
    p = _two_track()

    def fake_rms(project, track_id, t0, t1, caches=None):
        return -30.0 if track_id == "guest" else -55.0

    with patch(
        "podcast_mcp.edits.speech_energy_guard.measure_timeline_rms_db",
        side_effect=fake_rms,
    ):
        g = assess_cross_track_speech(
            p,
            "host",
            2.0,
            2.5,
            defaults={
                "tighten": {
                    "speech_energy_guard": {
                        "enabled": True,
                        "on_conflict": "track_local",
                        "min_other_rms_db": -42.0,
                        "dominance_db": 3.0,
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )
    assert g.blocked
    assert g.blocking_track_ids == ("guest",)
    assert g.action == "track_local"


def test_assess_allows_when_cut_track_dominates():
    p = _two_track()

    def fake_rms(project, track_id, t0, t1, caches=None):
        return -25.0 if track_id == "host" else -40.0

    with patch(
        "podcast_mcp.edits.speech_energy_guard.measure_timeline_rms_db",
        side_effect=fake_rms,
    ):
        g = assess_cross_track_speech(
            p,
            "host",
            2.0,
            2.5,
            defaults={
                "tighten": {
                    "speech_energy_guard": {
                        "enabled": True,
                        "min_other_rms_db": -42.0,
                        "dominance_db": 3.0,
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )
    assert not g.blocked


def test_resolve_skip_raises():
    p = _two_track()
    with (
        patch(
            "podcast_mcp.edits.speech_energy_guard.measure_timeline_rms_db",
            return_value=-30.0,
        ),
        pytest.raises(ValueError, match="cut blocked"),
    ):
        resolve_cut_scope(
            p,
            "host",
            2.0,
            2.5,
            defaults={
                "tighten": {
                    "speech_energy_guard": {
                        "enabled": True,
                        "on_conflict": "skip",
                        "min_other_rms_db": -42.0,
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )


def test_add_remove_decision_becomes_track_local(monkeypatch):
    p = _two_track(
        host_words=[
            TranscriptWord(text="hi", start=0.5, end=0.8),
            TranscriptWord(text="um", start=2.0, end=2.4),
            TranscriptWord(text="ok", start=3.0, end=3.2),
        ]
    )
    defaults = {
        "tighten": {
            "min_gap_after_filler_sec": 0.0,
            "filler_room_tone_replace": False,
            "speech_energy_guard": {
                "enabled": True,
                "on_conflict": "track_local",
                "min_other_rms_db": -42.0,
                "dominance_db": 3.0,
            },
        },
        "inaudible_cuts": {"enabled": False},
        "analysis": {"heuristics": {}},
    }

    def fake_rms(project, track_id, t0, t1, caches=None):
        return -30.0 if track_id == "guest" else -55.0

    def passthrough(project, track_id, start, end, force_enabled=None):
        from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

        return OptimizedCutRange(
            start=start,
            end=end,
            mode="exact",
            shifted_start_ms=0.0,
            shifted_end_ms=0.0,
            confidence=1.0,
            details={},
        )

    with (
        patch(
            "podcast_mcp.edits.speech_energy_guard.measure_timeline_rms_db",
            side_effect=fake_rms,
        ),
        patch(
            "podcast_mcp.edits.transcript_cuts.optimize_source_cut_range",
            side_effect=passthrough,
        ),
    ):
        d = add_remove_decision(p, "host", 2.0, 2.4, reason="nl:range", defaults=defaults)
    assert d.scope == "track"
    assert d.replace_gap_sec is None
    assert "track_local" in (d.reason or "")


def test_approve_track_local_keeps_peer_clips():
    p = _two_track()
    p.edit_decisions = [
        EditDecision(
            id="cut1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=2.0,
            end=2.5,
            review_required=True,
            applied=False,
            scope="track",
            reason="nl:range:track_local:guest",
        )
    ]
    with patch("podcast_mcp.edits.timeline_ops.optimize_timeline_cut_range") as opt:
        from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

        opt.return_value = OptimizedCutRange(
            start=2.0,
            end=2.5,
            mode="exact",
            shifted_start_ms=0.0,
            shifted_end_ms=0.0,
            confidence=1.0,
            details={},
        )
        n = approve_edits(p, ["cut1"])
    assert n == 1
    host = clips_for_track(p, "host")
    guest = clips_for_track(p, "guest")
    assert len(host) == 2
    assert host[0].timeline_end == pytest.approx(2.0)
    assert host[1].timeline_start == pytest.approx(2.5)
    # Guest untouched contiguous clip
    assert len(guest) == 1
    assert guest[0].timeline_start == pytest.approx(0.0)
    assert guest[0].timeline_end == pytest.approx(10.0)


def test_punch_delete_updates_one_track():
    p = _two_track()
    with patch("podcast_mcp.edits.timeline_ops.optimize_timeline_cut_range") as opt:
        from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange

        opt.return_value = OptimizedCutRange(
            start=1.0,
            end=1.5,
            mode="exact",
            shifted_start_ms=0.0,
            shifted_end_ms=0.0,
            confidence=1.0,
            details={},
        )
        punch_delete(p, "host", 1.0, 1.5, use_inaudible_opt=False)
    assert len(clips_for_track(p, "host")) == 2
    assert len(clips_for_track(p, "guest")) == 1


def test_resolve_cut_scope_speaker_bleed_short_circuits():
    p = _two_track()
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
        scope, guard = resolve_cut_scope(p, "host", 2.0, 2.5)
    assert scope == "track"
    assert guard is None


def test_resolve_cut_scope_speaker_exception_falls_through():
    p = _two_track()
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            side_effect=RuntimeError("boom"),
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.measure_timeline_rms_db",
            return_value=-60.0,
        ),
    ):
        scope, guard = resolve_cut_scope(p, "host", 2.0, 2.5)
    assert scope == "session"
    assert guard is not None
    assert not guard.blocked


def test_assess_disabled_returns_no_action() -> None:
    p = _two_track()
    g = assess_cross_track_speech(
        p,
        "host",
        2.0,
        2.5,
        defaults={
            "tighten": {"speech_energy_guard": {"enabled": False}},
            "analysis": {"heuristics": {}},
        },
    )
    assert g.action is None
    assert not g.blocked


def test_resolve_cut_scope_speaker_none_continues_to_rms():
    p = _two_track()
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={"host": object()},
        ),
        patch(
            "podcast_mcp.engines.speaker_id.assess_speaker_cut_role",
            return_value=None,
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.measure_timeline_rms_db",
            return_value=-60.0,
        ),
    ):
        scope, guard = resolve_cut_scope(p, "host", 2.0, 2.5)
    assert scope == "session"
    assert guard is not None


def test_assess_empty_span_returns_safe() -> None:
    p = _two_track()
    with patch("podcast_mcp.edits.speech_energy_guard.SessionTimeline") as ST:
        ST.return_value.map_source_span.return_value = []
        g = assess_cross_track_speech(
            p,
            "host",
            2.0,
            2.5,
            defaults={
                "tighten": {
                    "speech_energy_guard": {
                        "enabled": True,
                        "min_other_rms_db": -42.0,
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )
    assert not g.blocked


def test_assess_skips_quiet_other_tracks() -> None:
    p = _two_track()

    def fake_rms(project, track_id, t0, t1, caches=None):
        return -55.0 if track_id == "guest" else -30.0

    with patch(
        "podcast_mcp.edits.speech_energy_guard.measure_timeline_rms_db",
        side_effect=fake_rms,
    ):
        g = assess_cross_track_speech(
            p,
            "host",
            2.0,
            2.5,
            defaults={
                "tighten": {
                    "speech_energy_guard": {
                        "enabled": True,
                        "min_other_rms_db": -42.0,
                        "dominance_db": 3.0,
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )
    assert not g.blocked


def test_resolve_cut_scope_speaker_own_continues_to_rms():
    p = _two_track()
    with (
        patch(
            "podcast_mcp.engines.speaker_id.load_all_profiles",
            return_value={"host": object()},
        ),
        patch(
            "podcast_mcp.engines.speaker_id.assess_speaker_cut_role",
            return_value={"role": "own"},
        ),
        patch(
            "podcast_mcp.edits.speech_energy_guard.measure_timeline_rms_db",
            return_value=-60.0,
        ),
    ):
        scope, guard = resolve_cut_scope(p, "host", 2.0, 2.5)
    assert scope == "session"
    assert guard is not None
    assert not guard.blocked


def test_resolve_cut_scope_track_scope_short_circuits() -> None:
    p = _two_track()
    scope, guard = resolve_cut_scope(p, "host", 2.0, 2.5, requested_scope="track")
    assert scope == "track"
    assert guard is None


def test_assess_short_overlap_is_safe() -> None:
    p = _two_track()
    with patch("podcast_mcp.edits.speech_energy_guard.SessionTimeline") as ST:
        ST.return_value.map_source_span.return_value = [(0.0, 0.01)]
        g = assess_cross_track_speech(
            p,
            "host",
            2.0,
            2.5,
            defaults={
                "tighten": {
                    "speech_energy_guard": {
                        "enabled": True,
                        "min_overlap_sec": 0.03,
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )
    assert not g.blocked


def test_assess_invalid_source_range() -> None:
    p = _two_track()
    g = assess_cross_track_speech(p, "host", 2.5, 2.0)
    assert not g.blocked
    assert g.action is None


def test_assess_blocks_when_cut_rms_unknown_but_guest_hot() -> None:
    p = _two_track()

    def fake_rms(project, track_id, t0, t1, caches=None):
        if track_id == "guest":
            return -30.0
        return None

    with patch(
        "podcast_mcp.edits.speech_energy_guard.measure_timeline_rms_db",
        side_effect=fake_rms,
    ):
        g = assess_cross_track_speech(
            p,
            "host",
            2.0,
            2.5,
            defaults={
                "tighten": {
                    "speech_energy_guard": {
                        "enabled": True,
                        "min_other_rms_db": -42.0,
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )
    assert g.blocked
    assert g.blocking_track_ids == ("guest",)
