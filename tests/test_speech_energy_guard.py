"""Speech-energy guard and track-local punch."""

from __future__ import annotations

import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.clips_ops import clips_for_track, punch_timeline_range_from_clips
from podcast_mcp.edits.cut_application import approve_edits
from podcast_mcp.edits.cut_safety import (
    ResolvedCutScope,
    assess_cross_track_speech,
    resolve_cut_scope,
)
from podcast_mcp.edits.cut_speech import assess_cut_speech
from podcast_mcp.edits.ripple import RippleRemoval, TrackExtent, ripple_remove_clips
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.speech_energy_guard import _voice_refs, measure_peer_speech
from podcast_mcp.edits.timeline_ops import _write_punch_delete
from podcast_mcp.edits.transcript_cuts import add_remove_decision
from podcast_mcp.engines.audio_audit import (
    _played_window,
    build_track_rms_caches,
    measure_timeline_rms_db,
    timeline_frame_levels_db,
)
from podcast_mcp.engines.level_profile import LevelProfile
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.ungated_audio import raw_timeline_samples
from podcast_mcp.models import (
    Clip,
    CutIntent,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.dsp import bool_runs
from podcast_mcp.util.timebase import SourceSec


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


@pytest.fixture
def peer_floor(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every track's voice reaches -42 dBFS: these tests mock the span levels over media that is not on disk."""
    profile = LevelProfile(room_db=-60.0, speech_db=-15.0, loud_db=-15.0)
    assert profile.voice_reach_db == -42.0
    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard.track_level_profile", lambda *_a, **_k: profile
    )


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
    out = punch_timeline_range_from_clips(clips, 2.0, 2.5, defaults=load_defaults())
    assert len(out) == 2
    assert out[0].timeline_end == pytest.approx(2.0)
    assert out[1].timeline_start == pytest.approx(2.5)
    assert out[1].source_start == pytest.approx(2.5)
    # No ripple: right clip still ends at original timeline end
    assert out[1].timeline_end == pytest.approx(10.0)


@pytest.mark.usefixtures("peer_floor")
def test_assess_blocks_when_other_track_hot():
    p = _two_track()

    def fake_rms(project, track_id, t0, t1, caches=None, floor_db=-80.0, **_kw):
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
                        "on_conflict": "review",
                        "dominance_db": 3.0,
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )
    assert g.blocked
    assert g.blocking_track_ids == ("guest",)
    assert g.action == "review"


def test_voice_refs_keep_a_quiet_contrast_mic_on_path_reference() -> None:
    """#1529: a dialogue track recorded much quieter than the host is not bleed residue."""
    project = _two_track()
    host_profile = LevelProfile(room_db=-55.0, speech_db=-28.0, loud_db=-26.0)
    guest_profile = LevelProfile(room_db=-80.0, speech_db=-75.0, loud_db=-73.0)
    assert host_profile.has_contrast and guest_profile.has_contrast

    def profile(_project: EpisodeProject, track_id: str, _caches: object) -> LevelProfile:
        return host_profile if track_id == "host" else guest_profile

    def voice_db(_project: EpisodeProject, track_id: str, _caches: object) -> float:
        return profile(_project, track_id, _caches).path_reference_db

    with (
        patch("podcast_mcp.edits.speech_energy_guard._peer_profile", side_effect=profile),
        patch("podcast_mcp.edits.speech_energy_guard._track_voice_db", side_effect=voice_db),
    ):
        refs = _voice_refs(project, ["host", "guest"], caches=None)
    assert refs["guest"] == guest_profile.path_reference_db
    assert refs["guest"] < host_profile.path_reference_db - 40.0


@pytest.mark.usefixtures("peer_floor")
def test_assess_allows_when_cut_track_dominates():
    p = _two_track()

    def fake_rms(project, track_id, t0, t1, caches=None, floor_db=-80.0, **_kw):
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
                        "dominance_db": 3.0,
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )
    assert not g.blocked


@pytest.mark.usefixtures("peer_floor")
@pytest.mark.parametrize("guest_gain_db", [0.0, 20.0])
def test_a_balance_gain_on_the_peer_does_not_make_it_dominate(guest_gain_db: float):
    """#1549: the cut track is 15 dB louder as recorded; the guest's +20 dB balance gain lifts the
    level the mean path reads (recorded dB) above the host's, but moves no verdict."""
    p = _two_track()
    p.tracks[1].gain_db = guest_gain_db

    def fake_rms(project, track_id, t0, t1, caches=None, floor_db=-80.0, **_kw):
        return -25.0 if track_id == "host" else -40.0 + guest_gain_db

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
                "tighten": {"speech_energy_guard": {"enabled": True, "dominance_db": 3.0}},
                "analysis": {"heuristics": {}},
            },
        )
    assert not g.blocked


@pytest.mark.parametrize("peer_gain_db", [0.0, 20.0])
def test_owner_dominance_over_peer_frames_reads_the_recordings(peer_gain_db: float):
    """#1549: frame by frame, the owner owns a frame it out-sounds by the dominance margin as
    recorded, whatever balance gain the peer's track carries."""
    from podcast_mcp.edits.speech_energy_guard import _owned_peer_frames

    p = _two_track()
    p.tracks[1].gain_db = peer_gain_db

    def frames(project, track_id, start, end, **kw):
        # Owner 15 dB over the peer as recorded; a track reads its recorded level plus its gain.
        return np.full(4, -25.0 if track_id == "host" else -40.0 + peer_gain_db)

    with patch(
        "podcast_mcp.edits.speech_energy_guard.timeline_frame_levels_db", side_effect=frames
    ):
        got = _owned_peer_frames(
            p,
            "guest",
            2.0,
            2.2,
            owner_track_ids=["host"],
            dominance_db=3.0,
            caches=None,
            defaults=load_defaults(),
        )
    assert got is not None
    assert not got.own.any()


@pytest.mark.parametrize("owner_gain_db", [0.0, 20.0])
def test_owner_balance_gain_does_not_make_it_dominate_frames(owner_gain_db: float):
    """#1549: the peer is 1 dB under the owner as recorded, inside the dominance margin. The
    owner's balance gain lifts the level its frames read, but the peer still owns them."""
    from podcast_mcp.edits.speech_energy_guard import _owned_peer_frames

    p = _two_track()
    p.tracks[0].gain_db = owner_gain_db

    def frames(project, track_id, start, end, **kw):
        return np.full(4, -25.0 + owner_gain_db if track_id == "host" else -26.0)

    with patch(
        "podcast_mcp.edits.speech_energy_guard.timeline_frame_levels_db", side_effect=frames
    ):
        got = _owned_peer_frames(
            p,
            "guest",
            2.0,
            2.2,
            owner_track_ids=["host"],
            dominance_db=3.0,
            caches=None,
            defaults=load_defaults(),
        )
    assert got is not None
    assert got.own.all()


@pytest.mark.usefixtures("peer_floor")
@pytest.mark.parametrize("owner_gain_db", [0.0, 20.0])
def test_an_owner_balance_gain_does_not_hide_a_dominant_peer(owner_gain_db: float):
    """#1549: the guest is 15 dB over the host as recorded. The host's balance gain lifts the
    level the span read gives it above the guest's, but the guest still dominates."""
    p = _two_track()
    p.tracks[0].gain_db = owner_gain_db

    def fake_rms(project, track_id, t0, t1, caches=None, floor_db=-80.0, **_kw):
        return -20.0 if track_id == "guest" else -35.0 + owner_gain_db

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
                "tighten": {"speech_energy_guard": {"enabled": True, "dominance_db": 3.0}},
                "analysis": {"heuristics": {}},
            },
        )
    assert g.blocked


@pytest.mark.parametrize(
    ("peer_level", "owns"),
    [(-35.0, True), (-60.0, False)],
    ids=["peer_speaks", "owner_leak"],
)
def test_dominance_reads_each_mic_against_its_own_voice(
    monkeypatch: pytest.MonkeyPatch, peer_level: float, owns: bool
):
    """#1495/#1549: a call recording carries the guest 12 dB hotter than the guest's own mic, so as
    recorded the owner's track always out-sounds them. Read against each mic's own voice (host
    -25, guest -35 dBFS), the guest speaking at its voice level owns the frame; a guest 25 dB under
    its voice does not."""
    from podcast_mcp.edits.speech_energy_guard import _owned_peer_frames

    voices = {"host": -25.0, "guest": -35.0}
    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard._peer_profile",
        lambda _p, tid, _c: LevelProfile(room_db=-80.0, speech_db=voices[tid], loud_db=voices[tid]),
    )
    p = _two_track()

    def frames(project, track_id, start, end, **kw):
        # The host's track carries the guest at +12 dB over the guest's own mic.
        return np.full(4, -23.0 if track_id == "host" else peer_level)

    with patch(
        "podcast_mcp.edits.speech_energy_guard.timeline_frame_levels_db", side_effect=frames
    ):
        got = _owned_peer_frames(
            p,
            "guest",
            2.0,
            2.2,
            owner_track_ids=["host"],
            dominance_db=3.0,
            caches=None,
            defaults=load_defaults(),
        )
    assert got is not None
    assert bool(got.own.all()) is owns
    assert bool(got.own.any()) is owns


@pytest.mark.usefixtures("peer_floor")
def test_span_mean_reads_each_mic_against_its_own_voice(monkeypatch: pytest.MonkeyPatch):
    """#1495/#1549: with no frames to calibrate on, the guest speaking at its own voice level is
    heard even though the host's call track carries them 12 dB hotter."""
    voices = {"host": -25.0, "guest": -35.0}
    monkeypatch.setattr(
        "podcast_mcp.edits.speech_energy_guard._peer_profile",
        lambda _p, tid, _c: LevelProfile(room_db=-80.0, speech_db=voices[tid], loud_db=voices[tid]),
    )

    def fake_rms(project, track_id, t0, t1, caches=None, floor_db=-80.0, **_kw):
        return -23.0 if track_id == "host" else -35.0

    with patch(
        "podcast_mcp.edits.speech_energy_guard.measure_timeline_rms_db", side_effect=fake_rms
    ):
        g = assess_cross_track_speech(
            _two_track(),
            "host",
            2.0,
            2.5,
            defaults={
                "tighten": {"speech_energy_guard": {"enabled": True, "dominance_db": 3.0}},
                "analysis": {"heuristics": {}},
            },
        )
    assert g.blocked


@pytest.mark.usefixtures("peer_floor")
def test_resolve_skip_retains_peer_evidence():
    p = _two_track()
    with (
        patch(
            "podcast_mcp.edits.speech_energy_guard.measure_timeline_rms_db",
            return_value=-30.0,
        ),
    ):
        result = resolve_cut_scope(
            p,
            "host",
            2.0,
            2.5,
            defaults={
                "tighten": {
                    "speech_energy_guard": {
                        "enabled": True,
                        "on_conflict": "skip",
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )

    assert isinstance(result, ResolvedCutScope)
    assert result.cause == "peer_speech"
    assert result.guard.blocking_track_ids == ("guest",)
    assert result.guard.action == "skip"


@pytest.mark.usefixtures("peer_floor")
def test_add_remove_decision_over_peer_speech_waits_for_review(monkeypatch):
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
                "on_conflict": "review",
                "dominance_db": 3.0,
            },
        },
        "inaudible_cuts": {"enabled": False},
        "analysis": {"heuristics": {}},
    }

    def fake_rms(project, track_id, t0, t1, caches=None, floor_db=-80.0, **_kw):
        return -30.0 if track_id == "guest" else -55.0

    def passthrough(project, track_id, start, end, force_enabled=None, **_kw):
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
    assert d.scope == "session"
    assert d.review_required is True
    assert "other_speaking:guest" in (d.reason or "")


def test_approve_an_explicit_gap_keeps_peer_clips(tmp_path):
    p = _project_with_peer_audio(tmp_path, np.zeros(10 * _SR))
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
            reason="gap:delete",
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
        n = approve_edits(p, ["cut1"], defaults=load_defaults())
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
        _write_punch_delete(
            p,
            "host",
            1.0,
            1.5,
            defaults=load_defaults(),
        )
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
        resolved = resolve_cut_scope(p, "host", 2.0, 2.5, defaults=load_defaults())
        assert isinstance(resolved, ResolvedCutScope)
        scope, guard = resolved.scope, resolved.guard
    assert scope == "track"
    assert guard is None


@pytest.mark.usefixtures("peer_floor")
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
        resolved = resolve_cut_scope(p, "host", 2.0, 2.5, defaults=load_defaults())
        assert isinstance(resolved, ResolvedCutScope)
        scope, guard = resolved.scope, resolved.guard
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


@pytest.mark.usefixtures("peer_floor")
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
        resolved = resolve_cut_scope(p, "host", 2.0, 2.5, defaults=load_defaults())
        assert isinstance(resolved, ResolvedCutScope)
        scope, guard = resolved.scope, resolved.guard
    assert scope == "session"
    assert guard is not None


def test_assess_empty_span_returns_safe() -> None:
    p = _two_track()
    with patch("podcast_mcp.edits.cut_safety.SessionTimeline") as ST:
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
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )
    assert not g.blocked


@pytest.mark.usefixtures("peer_floor")
def test_assess_skips_quiet_other_tracks() -> None:
    p = _two_track()

    def fake_rms(project, track_id, t0, t1, caches=None, floor_db=-80.0, **_kw):
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
                        "dominance_db": 3.0,
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )
    assert not g.blocked


@pytest.mark.usefixtures("peer_floor")
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
        resolved = resolve_cut_scope(p, "host", 2.0, 2.5, defaults=load_defaults())
        assert isinstance(resolved, ResolvedCutScope)
        scope, guard = resolved.scope, resolved.guard
    assert scope == "session"
    assert guard is not None
    assert not guard.blocked


def test_resolve_cut_scope_track_scope_short_circuits() -> None:
    p = _two_track()
    resolved = resolve_cut_scope(
        p, "host", 2.0, 2.5, requested_scope="track", defaults=load_defaults()
    )
    assert isinstance(resolved, ResolvedCutScope)
    scope, guard = resolved.scope, resolved.guard
    assert scope == "track"
    assert guard is None


def test_assess_short_overlap_is_safe() -> None:
    p = _two_track()
    with patch("podcast_mcp.edits.cut_safety.SessionTimeline") as ST:
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
    g = assess_cross_track_speech(p, "host", 2.5, 2.0, defaults=load_defaults())
    assert not g.blocked
    assert g.action is None


@pytest.mark.usefixtures("peer_floor")
def test_assess_blocks_when_cut_rms_unknown_but_guest_hot() -> None:
    p = _two_track()

    def fake_rms(project, track_id, t0, t1, caches=None, floor_db=-80.0, **_kw):
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
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )
    assert g.blocked
    assert g.blocking_track_ids == ("guest",)


@pytest.mark.usefixtures("peer_floor")
def test_assess_blocks_on_peer_speech_in_smaller_of_two_mapped_spans() -> None:
    """A track-local hole inside the gap splits it into two mapped spans;
    peer speech in only the smaller span must still block (#793)."""
    p = _two_track()
    p.clips = [
        Clip(
            id="h1",
            track_id="host",
            source_start=0.0,
            source_end=3.0,
            timeline_start=0.0,
        ),
        # host-local punch hole 3.0-3.5: no clip covers it, no ripple.
        Clip(
            id="h2",
            track_id="host",
            source_start=3.5,
            source_end=10.0,
            timeline_start=3.5,
        ),
        Clip(
            id="g1",
            track_id="guest",
            source_start=0.0,
            source_end=10.0,
            timeline_start=0.0,
        ),
    ]

    # Proposed gap 2.8-3.6 straddles the hole: mapped spans are (2.8, 3.0)
    # (len 0.2, the largest) and (3.5, 3.6) (len 0.1, the smaller). Guest
    # speaks only in the smaller span.
    def fake_rms(project, track_id, t0, t1, caches=None, floor_db=-80.0, **_kw):
        if track_id == "guest":
            return -20.0 if t0 >= 3.5 else -60.0
        return -55.0

    with patch(
        "podcast_mcp.edits.speech_energy_guard.measure_timeline_rms_db",
        side_effect=fake_rms,
    ):
        g = assess_cross_track_speech(
            p,
            "host",
            2.8,
            3.6,
            defaults={
                "tighten": {
                    "speech_energy_guard": {
                        "enabled": True,
                        "on_conflict": "review",
                        "dominance_db": 3.0,
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )
    assert g.blocked
    assert g.blocking_track_ids == ("guest",)
    assert g.action == "review"


_GUARD_ON = {
    "tighten": {
        "speech_energy_guard": {
            "enabled": True,
            "on_conflict": "review",
            "dominance_db": 3.0,
        }
    },
    "analysis": {"heuristics": {}},
}
_SR = 16_000


def _write_wav(path: Path, signal: np.ndarray, *, sample_rate: int = _SR) -> None:
    data = (np.clip(signal, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        out.writeframes(data.tobytes())


def _host_speech(samples: int) -> np.ndarray:
    """A host that speaks in the first second over a gated room: the session's voice level."""
    clock = np.arange(samples) / _SR
    voice = clock < 1.0
    return np.where(voice, 0.1 * np.sin(2 * np.pi * 150 * clock), 0.0)


def _project_with_peer_audio(
    tmp_path: Path, peer: np.ndarray, *, host: np.ndarray | None = None
) -> EpisodeProject:
    p = _two_track(duration=peer.size / _SR)
    p.meta.workspace_dir = str(tmp_path)
    p.transcripts = []
    signals = {"host": np.zeros_like(peer) if host is None else host, "guest": peer}
    for track in p.tracks:
        assert track.media is not None
        path = tmp_path / f"{track.id}.wav"
        _write_wav(path, signals[track.id])
        track.media.path = str(path)
    return p


@pytest.mark.parametrize("amplitude", [0.045, 0.0045], ids=["normal", "quiet"])
def test_assess_blocks_brief_untranscribed_peer_in_long_pause(
    tmp_path: Path, amplitude: float
) -> None:
    clock = np.arange(8 * _SR) / _SR
    carrier = np.sin(2 * np.pi * 220 * clock)
    peer = np.zeros_like(clock)
    reference = (clock >= 0.1) & (clock < 0.8)
    brief = (clock >= 3.0) & (clock < 3.1)
    peer[reference | brief] = amplitude * carrier[reference | brief]
    p = _project_with_peer_audio(tmp_path, peer)

    reference_rms = measure_timeline_rms_db(p, "guest", 0.1, 0.8, defaults=load_defaults())
    brief_rms = measure_timeline_rms_db(p, "guest", 3.0, 3.1, defaults=load_defaults())
    assert reference_rms is not None
    assert brief_rms == pytest.approx(reference_rms, abs=0.1)

    guard = assess_cross_track_speech(p, "host", 1.0, 6.0, defaults=_GUARD_ON)

    assert guard.other_rms_db["guest"] < -42.0
    assert guard.blocked
    assert guard.blocking_track_ids == ("guest",)
    assert guard.action == "review"


@pytest.mark.parametrize("amplitude", [0.045, 0.0045], ids=["normal", "quiet"])
def test_assess_blocks_peer_attack_at_end_of_long_pause(tmp_path: Path, amplitude: float) -> None:
    clock = np.arange(8 * _SR) / _SR
    carrier = np.sin(2 * np.pi * 220 * clock)
    peer = np.zeros_like(clock)
    reference = (clock >= 0.1) & (clock < 0.8)
    peer[reference] = amplitude * carrier[reference]
    speech = (clock >= 5.98) & (clock < 6.5)
    attack = np.minimum(1.0, (clock[speech] - 5.98) / 0.05)
    peer[speech] = amplitude * attack * carrier[speech]
    p = _project_with_peer_audio(tmp_path, peer)

    attack_rms = measure_timeline_rms_db(p, "guest", 5.98, 6.0, defaults=load_defaults())
    following_rms = measure_timeline_rms_db(p, "guest", 6.04, 6.08, defaults=load_defaults())
    assert attack_rms is not None
    assert following_rms is not None
    assert attack_rms < -42.0
    assert following_rms > attack_rms + 10.0

    guard = assess_cross_track_speech(p, "host", 1.0, 6.0, defaults=_GUARD_ON)

    assert guard.other_rms_db["guest"] < -42.0
    assert guard.blocked
    assert guard.blocking_track_ids == ("guest",)
    assert guard.action == "review"


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize(
    ("owner_case", "expected"),
    [("same_time", ()), ("elsewhere", ("guest",)), ("loud_copy_elsewhere", ("guest",))],
)
def test_peer_frames_discount_only_concurrent_owner_bleed(
    tmp_path: Path, cached: bool, owner_case: str, expected: tuple[str, ...]
) -> None:
    clock = np.arange(8 * _SR) / _SR
    carrier = np.sin(2 * np.pi * 220 * clock)
    brief = (clock >= 3.0) & (clock < 3.1)
    elsewhere = (clock >= 4.0) & (clock < 5.0)
    peer = np.zeros_like(clock)
    owner = np.zeros_like(clock)
    # Within 27 dB of the loud copy that sets this track's voice level (#1549).
    peer[brief] = 0.02 * carrier[brief]
    if owner_case == "same_time":
        owner[brief] = 0.1 * carrier[brief]
        # The peer's own voice, outside the checked span: against it the owner is far louder.
        voice = (clock >= 7.0) & (clock < 7.5)
        peer[voice] = 0.1 * carrier[voice]
    else:
        owner[elsewhere] = 0.6 * carrier[elsewhere]
        if owner_case == "loud_copy_elsewhere":
            peer[elsewhere] = 0.3 * carrier[elsewhere]
    p = _project_with_peer_audio(tmp_path, peer)
    _write_wav(tmp_path / "host.wav", owner)
    caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None

    levels = measure_peer_speech(
        p,
        [(1.0, 6.0)],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
        caches=caches,
    )
    assert levels is not None
    assert levels.speaking == expected
    assert levels.unread == {}
    assert levels.peer_rms_db["guest"] == pytest.approx(
        measure_timeline_rms_db(p, "guest", 1.0, 6.0, caches=caches, defaults=load_defaults())
    )
    guard = assess_cross_track_speech(p, "host", 1.0, 6.0, defaults=_GUARD_ON, caches=caches)
    assert guard.blocking_track_ids == expected


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize(
    ("peer_case", "expected"),
    [("brief", ("guest",)), ("bleed", ()), ("digital_zero_gap", ())],
)
def test_dense_owner_bleed_cannot_hide_brief_independent_peer(
    tmp_path: Path, cached: bool, peer_case: str, expected: tuple[str, ...]
) -> None:
    clock = np.arange(8 * _SR) / _SR
    carrier = np.sin(2 * np.pi * 220 * clock)
    owner = 0.6 * carrier
    peer = 0.3 * carrier
    brief = (clock >= 3.0) & (clock < 3.1)
    if peer_case != "bleed":
        owner[brief] = 0.0
        peer[brief] = 0.0045 * carrier[brief] if peer_case == "brief" else 0.0
    p = _project_with_peer_audio(tmp_path, peer)
    _write_wav(tmp_path / "host.wav", owner)
    caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None

    levels = measure_peer_speech(
        p,
        [(1.0, 6.0)],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
        caches=caches,
    )
    assert levels is not None
    assert levels.owner_rms_db is not None
    assert levels.owner_rms_db - levels.peer_rms_db["guest"] > 3.0
    assert levels.speaking == expected
    assert levels.unread == {}
    guard = assess_cross_track_speech(p, "host", 1.0, 6.0, defaults=_GUARD_ON, caches=caches)
    assert guard.blocking_track_ids == expected
    assert guard.action == ("review" if expected else None)


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
def test_stationary_quiet_room_with_sparse_owner_activity_stays_clear(
    tmp_path: Path, cached: bool
) -> None:
    clock = np.arange(8 * _SR) / _SR
    carrier = np.sin(2 * np.pi * 220 * clock)
    owner = np.zeros_like(clock)
    burst = (clock >= 2.0) & (clock < 2.1)
    owner[burst] = 0.6 * carrier[burst]
    peer = np.random.default_rng(14).normal(0.0, 0.0004, clock.size)
    p = _project_with_peer_audio(tmp_path, peer)
    _write_wav(tmp_path / "host.wav", owner)
    caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None

    levels = measure_peer_speech(
        p,
        [(1.0, 6.0)],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
        caches=caches,
    )
    assert levels is not None
    assert levels.speaking == ()
    assert levels.unread == {}


def _voice(clock: np.ndarray, f0: float, amplitude: float) -> np.ndarray:
    harmonics = sum(np.sin(2 * np.pi * f0 * k * clock) / k for k in range(1, 7))
    return amplitude * harmonics / 2.0


def _dense_bleed_with_independent_gap(
    clock: np.ndarray, gap: tuple[float, float], content: str, *, owner_f0: float = 220.0
) -> tuple[np.ndarray, np.ndarray]:
    """Owner speaks throughout and bleeds into the peer, except in ``gap``."""
    rng = np.random.default_rng(14)
    noise = rng.normal(0.0, 0.0004, clock.size)
    owner = 0.6 * np.sin(2 * np.pi * owner_f0 * clock)
    peer = 0.3 * np.sin(2 * np.pi * owner_f0 * clock)
    inside = (clock >= gap[0]) & (clock < gap[1])
    remark = (clock >= (gap[0] + gap[1]) / 2 - 0.05) & (clock < (gap[0] + gap[1]) / 2 + 0.05)
    owner[inside] = 0.0
    peer[inside] = noise[inside]
    if content == "hum_room":
        hum = 0.0008 * np.sin(2 * np.pi * 50.0 * clock[inside] + 0.7)
        peer[inside] = hum + noise[inside]
    elif content == "rumble_room":
        rumble = 0.0006 * np.sin(2 * np.pi * 25.0 * clock[inside])
        peer[inside] = rumble + 0.1 * noise[inside]
    elif content == "tone_same_pitch":
        peer[inside] = 0.0045 * np.sin(2 * np.pi * owner_f0 * clock[inside])
    elif content == "tone_other_pitch":
        peer[inside] = 0.0045 * np.sin(2 * np.pi * 140.0 * clock[inside])
    elif content == "voice_over_room":
        peer[remark] += _voice(clock[remark], 150.0, 0.004)
    elif content == "reverb_tail":
        since = clock[inside] - gap[0]
        peer[inside] += rng.normal(0.0, 0.01, since.size) * 10 ** (-3.0 * since / 0.15)
    elif content == "unvoiced_burst_over_room":
        peer[remark] += rng.normal(0.0, 0.02, int(remark.sum()))
    return owner, peer


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize("gain", [-20.0, 0.0, 30.0])
@pytest.mark.parametrize(
    ("content", "gap", "expected"),
    [
        ("room_noise", (3.0, 3.1), ()),
        ("room_noise", (3.0, 3.3), ()),
        ("hum_room", (3.0, 3.3), ()),
        ("rumble_room", (3.0, 3.3), ()),
        ("tone_same_pitch", (3.0, 3.1), ("guest",)),
        ("tone_other_pitch", (3.0, 3.1), ("guest",)),
        ("voice_over_room", (3.0, 3.3), ("guest",)),
        ("unvoiced_burst_over_room", (3.0, 3.3), ("guest",)),
        ("room_noise", (3.0, 3.01), ()),
        ("room_noise", (3.0, 3.03), ()),
        ("reverb_tail", (3.0, 3.3), ()),
        ("room_noise", (3.0, 3.05), ()),
    ],
    ids=[
        "room_100ms",
        "room_300ms",
        "room_with_low_hum",
        "low_rumble_room",
        "voice_at_owner_pitch",
        "voice_at_other_pitch",
        "voice_over_room",
        "unvoiced_burst_over_room",
        "room_one_stray_frame",
        "room_three_stray_frames",
        "reverb_tail_in_gap",
        "room_under_three_probes",
    ],
)
def test_dense_owner_bleed_room_is_told_from_independent_peer_by_the_peers_own_sound(
    tmp_path: Path, cached: bool, gain: float, content: str, gap: tuple[float, float], expected
) -> None:
    clock = np.arange(8 * _SR) / _SR
    owner, peer = _dense_bleed_with_independent_gap(clock, gap, content)
    p = _project_with_peer_audio(tmp_path, peer)
    _write_wav(tmp_path / "host.wav", owner)
    for track in p.tracks:
        track.gain_db = gain
    caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None

    levels = measure_peer_speech(
        p,
        [(1.0, 6.0)],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
        caches=caches,
    )
    assert levels is not None
    assert levels.speaking == expected
    assert levels.unread == {}
    guard = assess_cross_track_speech(p, "host", 1.0, 6.0, defaults=_GUARD_ON, caches=caches)
    assert guard.blocking_track_ids == expected
    assert guard.action == ("review" if expected else None)


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize("gain", [-20.0, 0.0, 30.0])
@pytest.mark.parametrize("remark_scale", [0.1, 0.15], ids=["quiet_okay", "softer_okay"])
def test_dense_owner_bleed_warns_on_quiet_backchannel_near_bleed_floor(
    tmp_path: Path, cached: bool, gain: float, remark_scale: float
) -> None:
    """Regression for #1357: voiced remarks under the dense-bleed room reference still warn."""
    clock = np.arange(8 * _SR) / _SR
    owner, peer = _dense_bleed_with_independent_gap(clock, (3.0, 3.3), "room_noise")
    remark = (clock >= (3.0 + 3.3) / 2 - 0.05) & (clock < (3.0 + 3.3) / 2 + 0.05)
    peer[remark] += remark_scale * _voice(clock[remark], 150.0, 0.004)
    p = _project_with_peer_audio(tmp_path, peer)
    _write_wav(tmp_path / "host.wav", owner)
    for track in p.tracks:
        track.gain_db = gain
    caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None

    levels = measure_peer_speech(
        p,
        [(1.0, 6.0)],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
        caches=caches,
    )
    assert levels is not None
    assert levels.speaking == ("guest",)
    guard = assess_cross_track_speech(p, "host", 1.0, 6.0, defaults=_GUARD_ON, caches=caches)
    assert guard.blocking_track_ids == ("guest",)


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize("gain", [-20.0, 0.0, 30.0])
def test_dense_owner_bleed_room_reference_ignores_a_single_quieter_stretch(
    tmp_path: Path, cached: bool, gain: float
) -> None:
    clock = np.arange(8 * _SR) / _SR
    owner, peer = _dense_bleed_with_independent_gap(clock, (3.0, 3.3), "room_noise")
    dip = (clock >= 3.12) & (clock < 3.18)
    peer[dip] *= 0.3
    p = _project_with_peer_audio(tmp_path, peer)
    _write_wav(tmp_path / "host.wav", owner)
    for track in p.tracks:
        track.gain_db = gain
    caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None

    guard = assess_cross_track_speech(p, "host", 1.0, 6.0, defaults=_GUARD_ON, caches=caches)
    assert guard.blocking_track_ids == ()


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
def test_dense_owner_bleed_room_warns_when_the_peers_samples_cannot_be_read(
    tmp_path: Path, cached: bool
) -> None:
    clock = np.arange(8 * _SR) / _SR
    owner, peer = _dense_bleed_with_independent_gap(clock, (3.0, 3.1), "room_noise")
    p = _project_with_peer_audio(tmp_path, peer)
    _write_wav(tmp_path / "host.wav", owner)
    caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None
    with patch("podcast_mcp.edits.speech_energy_guard.timeline_window_samples", return_value=None):
        levels = measure_peer_speech(
            p,
            [(1.0, 6.0)],
            owner_track_ids=["host"],
            peer_track_ids=["guest"],
            defaults=_GUARD_ON,
            caches=caches,
        )
    assert levels is not None
    assert levels.speaking == ("guest",)


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize("gain", [-20.0, 0.0, 30.0])
@pytest.mark.parametrize("silent", [False, True], ids=["noise", "digital_zero"])
def test_noise_without_contrast_uses_mean_while_digital_zero_stays_clear(
    tmp_path: Path, cached: bool, gain: float, silent: bool
) -> None:
    peer = np.zeros(8 * _SR) if silent else np.random.default_rng(14).normal(0.0, 0.0004, 8 * _SR)
    p = _project_with_peer_audio(tmp_path, peer, host=_host_speech(peer.size))
    p.tracks[1].gain_db = gain
    p.transcripts = [
        Transcript(track_id="guest", words=[TranscriptWord(text="right", start=3.0, end=3.1)])
    ]
    caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None

    levels = measure_peer_speech(
        p,
        [(1.0, 6.0)],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
        caches=caches,
    )
    assert levels is not None
    expected = ("guest",) if not silent and gain == 30.0 else ()
    assert levels.speaking == expected
    assert levels.unread == {}
    guard = assess_cross_track_speech(p, "host", 1.0, 6.0, defaults=_GUARD_ON, caches=caches)
    assert guard.blocking_track_ids == expected
    assert guard.action == ("review" if expected else None)


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
def test_continuous_hot_peer_without_quiet_context_still_blocks(
    tmp_path: Path, cached: bool
) -> None:
    clock = np.arange(8 * _SR) / _SR
    p = _project_with_peer_audio(tmp_path, 0.1 * np.sin(2 * np.pi * 220 * clock))
    caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None

    levels = measure_peer_speech(
        p,
        [(1.0, 6.0)],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
        caches=caches,
    )
    assert levels is not None
    assert levels.speaking == ("guest",)
    assert levels.unread == {}
    guard = assess_cross_track_speech(p, "host", 1.0, 6.0, defaults=_GUARD_ON, caches=caches)
    assert guard.blocking_track_ids == ("guest",)


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize(
    ("sound_start", "sound_end", "expected"),
    [
        (0.944, 0.964, ("guest",)),
        (0.914, 0.934, ()),
        (6.024, 6.044, ("guest",)),
        (6.064, 6.084, ()),
        (6.062, 6.063, ("guest",)),
        (0.941, 0.9429375, ()),
        (0.943, 0.9430625, ("guest",)),
    ],
    ids=[
        "left_pad",
        "before_pad",
        "right_pad",
        "after_pad",
        "non_grid_tail",
        "sample_before_left_pad",
        "first_sample_in_left_pad",
    ],
)
def test_peer_detection_stops_at_exact_outward_pad_boundary(
    tmp_path: Path,
    cached: bool,
    sound_start: float,
    sound_end: float,
    expected: tuple[str, ...],
) -> None:
    clock = np.arange(8 * _SR) / _SR
    peer = np.zeros_like(clock)
    active = (clock >= sound_start) & (clock < sound_end)
    peer[active] = 0.045 * np.sin(2 * np.pi * 220 * clock[active])
    p = _project_with_peer_audio(tmp_path, peer)
    caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None

    levels = measure_peer_speech(
        p,
        [(1.003, 6.003)],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
        caches=caches,
    )
    assert levels is not None
    assert levels.speaking == expected
    assert levels.unread == {}
    guard = assess_cross_track_speech(p, "host", 1.003, 6.003, defaults=_GUARD_ON, caches=caches)
    assert guard.blocking_track_ids == expected


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize("edge", ["before_start", "first_inside", "last_inside", "at_end"])
def test_sealed_peer_detection_contains_exact_half_open_samples(
    tmp_path: Path, cached: bool, edge: str
) -> None:
    for start, end, samples in [
        (1.003, 3.003, (8023, 8024, 24023, 24024)),
        (1.00304, 3.00704, (8023, 8024, 24055, 24056)),
    ]:
        peer = np.zeros(8 * _SR)
        index = samples[("before_start", "first_inside", "last_inside", "at_end").index(edge)]
        peer[index * 2] = 0.045
        p = _project_with_peer_audio(tmp_path, peer)
        _write_wav(tmp_path / "guest.wav", peer[::2], sample_rate=8000)
        forward = p.model_copy(deep=True)
        ripple_remove_clips(forward, [(start, end)], ["host", "guest"], defaults=load_defaults())
        remaining = 0 if edge in ("first_inside", "last_inside") else 1
        assert (
            np.count_nonzero(_played_window(forward, "guest", 0.0, 8.0, defaults=load_defaults()))
            == remaining
        )
        assert np.count_nonzero(raw_timeline_samples(forward, "guest")) == remaining
        caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None
        kwargs = {
            "owner_track_ids": ["host"],
            "peer_track_ids": ["guest"],
            "defaults": _GUARD_ON,
            "caches": caches,
        }
        generic = measure_peer_speech(p, [(start, end)], **kwargs)
        sealed = measure_peer_speech(p, [(start, end)], _admissible_spans=((start, end),), **kwargs)
        assert generic is not None and sealed is not None
        assert generic.speaking == ("guest",)
        assert sealed.speaking == (("guest",) if edge in ("first_inside", "last_inside") else ())
        assert sealed.owner_rms_db == generic.owner_rms_db
        assert sealed.peer_rms_db == generic.peer_rms_db
        assert sealed.unread == generic.unread == {}


@pytest.mark.parametrize("origin", [0.0, 0.00008, 0.10008, 0.00004])
@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
def test_sealed_peer_boundaries_follow_native_forward_removal(
    tmp_path: Path, origin: float, cached: bool
) -> None:
    for index, removed in [(8024, True), (24024, False)]:
        peer = np.zeros(8 * _SR)
        peer[index * 2] = 0.045
        p = _project_with_peer_audio(tmp_path, peer)
        _write_wav(tmp_path / "guest.wav", peer[::2], sample_rate=8000)
        p.clips[0].timeline_start = 0.50004
        p.clips[1].source_start = origin
        p.clips[1].timeline_start = 0.50004 + origin
        p.timeline.duration_sec = 8.50004
        spans = tuple(
            (float(a), float(b))
            for a, b in SessionTimeline(p).map_source_span(
                "host", SourceSec(1.003), SourceSec(3.003)
            )
        )
        before = _played_window(p, "guest", 0.0, 8.50004, defaults=load_defaults())
        before_cache = raw_timeline_samples(p, "guest")
        assert np.count_nonzero(before) == np.count_nonzero(before_cache) == 1
        forward = p.model_copy(deep=True)
        ripple_remove_clips(forward, spans, ["host", "guest"], defaults=load_defaults())
        expected_count = 0 if removed else 1
        assert (
            np.count_nonzero(
                _played_window(forward, "guest", 0.0, 6.50004, defaults=load_defaults())
            )
            == expected_count
        )
        assert np.count_nonzero(raw_timeline_samples(forward, "guest")) == expected_count
        levels = measure_peer_speech(
            p,
            spans,
            owner_track_ids=["host"],
            peer_track_ids=["guest"],
            defaults=_GUARD_ON,
            caches=build_track_rms_caches(p, defaults=load_defaults()) if cached else None,
            _admissible_spans=spans,
        )
        assert levels is not None
        assert levels.speaking == (("guest",) if removed else ())
        assert levels.unread == {}
        removal = RippleRemoval.of([TrackExtent("host", *spans[0])])
        clearance = assess_cut_speech(p, removal, defaults=_GUARD_ON)
        assert (clearance is not None) is removed
        edit = EditDecision(
            id="native-boundary",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.003,
            end=3.003,
            scope="session",
            reason="nl:range",
            boundary_mode="exact",
            review_required=False,
            applied=False,
        )
        p.edit_decisions.append(edit)
        snapshot = p.model_dump(mode="json")
        if removed:
            with pytest.raises(ScopeChangedAtApproval) as held:
                approve_edits(p, [edit.id], defaults=load_defaults())
            assert held.value.held[0].reason == "peer_speech"
            assert np.array_equal(
                _played_window(p, "guest", 0.0, 8.50004, defaults=load_defaults()), before
            )
            assert clearance is not None
            assert (
                approve_edits(
                    p,
                    [edit.id],
                    application_intent=CutIntent.HUMAN_BOUNDARIES,
                    defaults=load_defaults(),
                )
                == 1
            )
            assert (
                np.count_nonzero(_played_window(p, "guest", 0.0, 6.50004, defaults=load_defaults()))
                == 0
            )
            assert np.count_nonzero(raw_timeline_samples(p, "guest")) == 0
        else:
            with pytest.raises(ScopeChangedAtApproval) as held:
                approve_edits(p, [edit.id], defaults=load_defaults())
            assert held.value.held[0].reason == "acoustic_edge"
            assert held.value.held[0].detail == "breath_edge"
            assert p.model_dump(mode="json") == snapshot
            assert np.array_equal(
                _played_window(p, "guest", 0.0, 8.50004, defaults=load_defaults()), before
            )
            assert np.array_equal(raw_timeline_samples(p, "guest"), before_cache)
            assert (
                approve_edits(
                    p,
                    [edit.id],
                    application_intent=CutIntent.HUMAN_BOUNDARIES,
                    defaults=load_defaults(),
                )
                == 1
            )
            after = _played_window(p, "guest", 0.0, 6.50004, defaults=load_defaults())
            assert np.count_nonzero(after) == 1
            assert after[after != 0].tolist() == before[before != 0].tolist()


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
def test_source_removal_preserves_nearest_even_split_endpoint(tmp_path: Path, cached: bool) -> None:
    for index, removed in [(24056, False), (24055, True)]:
        peer = np.zeros(8 * _SR)
        peer[index * 2] = 0.045
        p = _project_with_peer_audio(tmp_path, peer)
        _write_wav(tmp_path / "guest.wav", peer[::2], sample_rate=8000)
        p.clips[0].timeline_start = 0.7001
        p.clips[1].source_start = 0.00003
        p.clips[1].timeline_start = 0.7001 + 0.00003
        for clip in p.clips:
            clip.source_end = 7.9
        p.timeline.duration_sec = 8.7001
        spans = tuple(
            (float(a), float(b))
            for a, b in SessionTimeline(p).map_source_span(
                "host", SourceSec(1.0030625), SourceSec(3.0070625)
            )
        )
        before = _played_window(p, "guest", 0.0, 8.7001, defaults=load_defaults())
        before_cache = raw_timeline_samples(p, "guest")
        assert np.count_nonzero(before) == np.count_nonzero(before_cache) == 1
        forward = p.model_copy(deep=True)
        ripple_remove_clips(forward, spans, ["host", "guest"], defaults=load_defaults())
        expected_count = 0 if removed else 1
        for samples in (
            _played_window(forward, "guest", 0.0, 8.7001, defaults=load_defaults()),
            raw_timeline_samples(forward, "guest"),
        ):
            assert np.count_nonzero(samples) == expected_count
            if not removed:
                assert samples[samples != 0].tolist() == [0.04498291015625]
        levels = measure_peer_speech(
            p,
            spans,
            owner_track_ids=["host"],
            peer_track_ids=["guest"],
            defaults=_GUARD_ON,
            caches=build_track_rms_caches(p, defaults=load_defaults()) if cached else None,
            _admissible_spans=spans,
        )
        assert levels is not None
        assert levels.speaking == (("guest",) if removed else ())
        assert levels.unread == {}
        clearance = assess_cut_speech(
            p,
            RippleRemoval.of([TrackExtent("host", *spans[0])]),
            defaults=_GUARD_ON,
        )
        assert (clearance is not None) is removed
        edit = EditDecision(
            id="nearest-even-boundary",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0030625,
            end=3.0070625,
            scope="session",
            reason="nl:range",
            boundary_mode="exact",
            review_required=False,
            applied=False,
        )
        p.edit_decisions.append(edit)
        snapshot = p.model_dump(mode="json")
        if removed:
            with pytest.raises(ScopeChangedAtApproval) as held:
                approve_edits(p, [edit.id], defaults=load_defaults())
            assert held.value.held[0].reason == "peer_speech"
            assert p.model_dump(mode="json") == snapshot
            assert clearance is not None
            assert (
                approve_edits(
                    p,
                    [edit.id],
                    application_intent=CutIntent.HUMAN_BOUNDARIES,
                    defaults=load_defaults(),
                )
                == 1
            )
        else:
            with pytest.raises(ScopeChangedAtApproval) as held:
                approve_edits(p, [edit.id], defaults=load_defaults())
            assert held.value.held[0].reason == "acoustic_edge"
            assert held.value.held[0].detail == "breath_edge"
            assert p.model_dump(mode="json") == snapshot
            assert np.array_equal(
                _played_window(p, "guest", 0.0, 8.7001, defaults=load_defaults()), before
            )
            assert np.array_equal(raw_timeline_samples(p, "guest"), before_cache)
            assert (
                approve_edits(
                    p,
                    [edit.id],
                    application_intent=CutIntent.HUMAN_BOUNDARIES,
                    defaults=load_defaults(),
                )
                == 1
            )
        for samples in (
            _played_window(p, "guest", 0.0, 8.7001, defaults=load_defaults()),
            raw_timeline_samples(p, "guest"),
        ):
            assert np.count_nonzero(samples) == expected_count
            if not removed:
                assert samples[samples != 0].tolist() == [0.04498291015625]


def test_removal_geometry_requires_one_containing_component_per_sealed_query() -> None:
    for admissible, geometry in [
        (None, ((1.0, 3.0),)),
        (((1.0, 3.0),), ()),
        (((1.0, 3.0),), ((1.0, float("inf")),)),
        (((1.0, 3.0),), ((3.0, 1.0),)),
        (((1.0, 3.0),), ((4.0, 5.0), (1.0, 3.0))),
        (((1.0, 3.0),), ((1.0, 3.0), (2.0, 4.0))),
        (((1.0, 3.0),), ((1.0, 2.0), (2.5, 3.0))),
    ]:
        with pytest.raises(CodedValueError, match="one ordered component") as error:
            measure_peer_speech(
                _two_track(),
                [(1.0, 3.0)],
                owner_track_ids=["host"],
                peer_track_ids=["guest"],
                defaults=_GUARD_ON,
                _admissible_spans=admissible,
                _removal_spans=geometry,
            )
        assert error.value.code == "invalid_range"


def test_sealed_cached_samples_use_the_cache_timeline_origin(tmp_path: Path) -> None:
    for index, removed in [(8023, False), (24023, True)]:
        peer = np.zeros(8 * _SR)
        peer[index * 2] = 0.045
        p = _project_with_peer_audio(tmp_path, peer)
        _write_wav(tmp_path / "guest.wav", peer[::2], sample_rate=8000)
        for clip in p.clips:
            clip.timeline_start = 0.50004
        span = (1.50304, 3.50304)
        forward = p.model_copy(deep=True)
        ripple_remove_clips(forward, [span], ["host", "guest"], defaults=load_defaults())
        assert np.count_nonzero(raw_timeline_samples(forward, "guest")) == (0 if removed else 1)
        caches = build_track_rms_caches(p, defaults=load_defaults())
        for cache in caches.caches.values():
            cache.samples = cache.samples[4000:]
            cache.timeline_offset_sec = 0.50004
        levels = measure_peer_speech(
            p,
            [span],
            owner_track_ids=["host"],
            peer_track_ids=["guest"],
            defaults=_GUARD_ON,
            caches=caches,
            _admissible_spans=(span,),
        )
        assert levels is not None
        assert levels.speaking == (("guest",) if removed else ())
        assert levels.unread == {}


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize("gap", [False, True], ids=["shifted", "core_gap"])
def test_peer_room_calibration_uses_played_context_and_core_coverage(
    tmp_path: Path, cached: bool, gap: bool
) -> None:
    clock = np.arange(8 * _SR) / _SR
    peer = np.random.default_rng(1940).normal(0.0, 0.0004, clock.size)
    voice = (clock >= 4.22) & (clock < 4.26)
    peer[voice] = 0.03 * np.sin(2 * np.pi * 220 * clock[voice])
    p = _project_with_peer_audio(tmp_path, peer, host=_host_speech(peer.size))
    p.clips[1].source_start = p.clips[1].timeline_start = 4.0
    p.clips[1].source_end = 4.5 if gap else 6.0
    if gap:
        p.clips.append(
            Clip(id="g2", track_id="guest", source_start=4.89, source_end=6.0, timeline_start=4.89)
        )
    caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None
    levels = measure_peer_speech(
        p,
        [(4.625, 4.9)],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
        caches=caches,
    )
    assert levels is not None
    assert levels.speaking == ()
    assert levels.unread == {}


@pytest.mark.parametrize("amplitude", [0.045, 0.0004], ids=["hot", "quiet"])
def test_unavailable_frames_use_readable_mean_without_word_fallback(
    tmp_path: Path, amplitude: float
) -> None:
    clock = np.arange(8 * _SR) / _SR
    p = _project_with_peer_audio(
        tmp_path, amplitude * np.sin(2 * np.pi * 220 * clock), host=_host_speech(clock.size)
    )
    p.transcripts = [
        Transcript(track_id="guest", words=[TranscriptWord(text="right", start=3.0, end=3.1)])
    ]
    with patch("podcast_mcp.edits.speech_energy_guard.timeline_frame_levels_db", return_value=None):
        levels = measure_peer_speech(
            p,
            [(1.0, 6.0)],
            owner_track_ids=["host"],
            peer_track_ids=["guest"],
            defaults=_GUARD_ON,
        )
        guard = assess_cross_track_speech(p, "host", 1.0, 6.0, defaults=_GUARD_ON)
    expected = ("guest",) if amplitude == 0.045 else ()
    assert levels is not None
    assert levels.speaking == expected
    assert levels.unread == {}
    assert guard.blocking_track_ids == expected


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
def test_separate_spans_keep_independent_peer_calibration(tmp_path: Path, cached: bool) -> None:
    clock = np.arange(20 * _SR) / _SR
    carrier = np.sin(2 * np.pi * 220 * clock)
    peer = np.zeros_like(clock)
    owner = np.zeros_like(clock)
    copy = (clock >= 1.0) & (clock < 2.0)
    brief = (clock >= 16.1) & (clock < 16.2)
    owner[copy] = 0.6 * carrier[copy]
    peer[copy] = 0.3 * carrier[copy]
    # Within 27 dB of the loud copy that sets this track's voice level (#1549).
    peer[brief] = 0.02 * carrier[brief]
    p = _project_with_peer_audio(tmp_path, peer)
    _write_wav(tmp_path / "host.wav", owner)
    p.clips[0].source_end = 2.0
    p.clips.insert(
        1,
        Clip(id="h2", track_id="host", source_start=16.0, source_end=20.0, timeline_start=16.0),
    )
    caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None

    levels = measure_peer_speech(
        p,
        [(1.0, 2.0), (16.0, 17.0)],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
        caches=caches,
    )
    assert levels is not None
    assert levels.speaking == ("guest",)
    assert levels.unread == {}
    assert levels.peer_rms_db["guest"] == pytest.approx(
        measure_timeline_rms_db(p, "guest", 1.0, 2.0, caches=caches, defaults=load_defaults())
    )
    guard = assess_cross_track_speech(p, "host", 1.0, 17.0, defaults=_GUARD_ON, caches=caches)
    assert guard.blocking_track_ids == ("guest",)


def test_bounded_core_frames_survive_unreadable_optional_context(tmp_path: Path) -> None:
    clock = np.arange(20 * _SR) / _SR
    peer = np.zeros_like(clock)
    brief = (clock >= 13.0) & (clock < 13.1)
    peer[brief] = 0.0045 * np.sin(2 * np.pi * 220 * clock[brief])
    p = _project_with_peer_audio(tmp_path, peer)
    requests: list[tuple[str, float, float]] = []

    def read(project, track_id, start, end, *, frame_sec, hop_sec, caches, **_kw):
        requests.append((track_id, start, end))
        if start < 0.94 or end > 15.06:
            return None
        assert frame_sec == hop_sec == 0.01
        return timeline_frame_levels_db(
            project,
            track_id,
            start,
            end,
            frame_sec=frame_sec,
            hop_sec=hop_sec,
            caches=caches,
            defaults=load_defaults(),
        )

    with patch("podcast_mcp.edits.speech_energy_guard.timeline_frame_levels_db", side_effect=read):
        levels = measure_peer_speech(
            p,
            [(1.0, 15.0)],
            owner_track_ids=["host"],
            peer_track_ids=["guest"],
            defaults=_GUARD_ON,
        )
    assert levels is not None
    assert levels.speaking == ("guest",)
    assert levels.unread == {}
    assert all(end - start <= 5.0 + 1e-9 for _, start, end in requests)
    assert all(
        end - start <= 2.0 + 1e-9 for _, start, end in requests if start >= 0.94 and end <= 15.06
    )


def _peer_word_in_cut(*, suppressed: bool = False) -> EpisodeProject:
    """Host's "um" at 2.0-2.5 s; Guest's transcript says "right" at 2.1-2.4 s."""
    return _two_track(
        guest_words=[TranscriptWord(text="right", start=2.1, end=2.4, suppressed=suppressed)]
    )


def test_resolve_cut_scope_punches_over_peer_word_without_stems() -> None:
    p = _peer_word_in_cut()
    assert not any(Path(t.media.path).exists() for t in p.tracks if t.media)
    resolved = resolve_cut_scope(p, "host", 2.0, 2.5, defaults=_GUARD_ON)
    assert isinstance(resolved, ResolvedCutScope)
    scope, guard = resolved.scope, resolved.guard
    assert scope == "track"
    assert guard is not None
    assert guard.blocking_track_ids == ("guest",)
    assert guard.action == "review"


def test_resolve_cut_scope_ripples_over_suppressed_peer_word_without_stems() -> None:
    resolved = resolve_cut_scope(
        _peer_word_in_cut(suppressed=True), "host", 2.0, 2.5, defaults=_GUARD_ON
    )
    assert isinstance(resolved, ResolvedCutScope)
    assert resolved.scope == "session"
    assert resolved.guard is not None
    assert not resolved.guard.blocked


def test_resolve_cut_scope_with_stems_lets_sound_decide_over_peer_word(tmp_path: Path) -> None:
    p = _peer_word_in_cut()
    p.meta.workspace_dir = str(tmp_path)
    t = np.arange(int(10.0 * _SR)) / _SR
    signals = {
        "host": 0.1 * np.sin(2 * np.pi * 220 * t),
        "guest": np.random.default_rng(3).normal(0.0, 0.0003, t.size),
    }
    for track in p.tracks:
        assert track.media is not None
        path = tmp_path / f"{track.id}.wav"
        _write_wav(path, signals[track.id])
        track.media.path = str(path)
    resolved = resolve_cut_scope(p, "host", 2.0, 2.5, defaults=_GUARD_ON)
    assert isinstance(resolved, ResolvedCutScope)
    scope, guard = resolved.scope, resolved.guard
    assert scope == "session"
    assert guard is not None
    assert not guard.blocked


@pytest.mark.parametrize(
    ("burst", "expected"),
    [(0.0003, ()), (0.03, ("guest",))],
    ids=["room_noise", "quiet_voice"],
)
def test_a_burst_under_the_peers_voice_floor_is_not_speech(
    tmp_path: Path, burst: float, expected: tuple[str, ...]
) -> None:
    """#1549: the peer talks at -23 dBFS early on and is quiet around the cut. A 0.2 s burst 55 dB under that
    is room noise and clears the cut; one within 27 dB of it is a quiet voice and blocks."""
    clock = np.arange(20 * _SR) / _SR
    carrier = np.sin(2 * np.pi * 220 * clock)
    peer = 0.00003 * carrier
    voice = (clock >= 0.1) & (clock < 1.6)
    peer[voice] = 0.1 * carrier[voice]
    noise = (clock >= 14.0) & (clock < 14.2)
    peer[noise] = burst * carrier[noise]
    p = _project_with_peer_audio(tmp_path, peer)

    levels = measure_peer_speech(
        p,
        [(13.0, 16.0)],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
    )
    assert levels is not None
    assert levels.speaking == expected


def _colored_room(kind: str, size: int, rms: float, seed: int) -> np.ndarray:
    white = np.random.default_rng(seed).normal(0.0, 1.0, size)
    spectrum = np.fft.rfft(white)
    slope = np.arange(spectrum.size, dtype=float)
    slope[0] = 1.0
    noise = white if kind == "white" else np.fft.irfft(spectrum / np.sqrt(slope), size)
    return rms * noise / np.sqrt(np.mean(noise**2))


def _owner_words_over_room(
    kind: str,
    gap_sec: float,
    *,
    remark: str | None,
    bleed: float,
    tail: bool,
    lead: float = 0.15,
    remark_db: float | None = None,
    seed: int = 3,
) -> tuple[np.ndarray, np.ndarray, tuple[float, float]]:
    """A host who talks word after word ``gap_sec`` apart, bleeding into a guest in a steady room.

    The guest's own voice reads in the first second, the host's in the second; a ``remark`` sits
    in a half-second pause after the twelfth word.
    """
    words, word_sec = 24, 0.4
    pause = 0.5
    size = int((3.0 + words * (word_sec + gap_sec) + pause + 1.0) * _SR)
    clock = np.arange(size) / _SR
    owner = np.where((clock >= 1.0) & (clock < 2.0), 0.1 * np.sin(2 * np.pi * 150 * clock), 0.0)
    rng = np.random.default_rng(seed)
    speaking = np.zeros(size, dtype=bool)
    at, pause_at = 2.0, 0.0
    for word in range(words):
        mask = (clock >= at) & (clock < at + word_sec)
        speaking |= mask
        owner[mask] = 0.3 * np.sin(2 * np.pi * (200 + 10 * (word % 5)) * clock[mask])
        at += word_sec + gap_sec
        if word == 11:
            pause_at, at = at, at + pause
    peer = _colored_room(kind, size, 10 ** (-50.0 / 20), seed) + bleed * owner
    if tail:
        ring = rng.normal(0.0, 1.0, size)
        for _, end in bool_runs(speaking):
            after = np.arange(end, min(size, end + int(0.3 * _SR)))
            peer[after] += bleed * 0.15 * ring[after] * 10 ** (-3.0 * (after - end) / (0.3 * _SR))
    peer += np.where(clock < 1.0, _voice(clock, 140.0, 0.1), 0.0)
    if remark == "voiced":
        said = (clock >= pause_at + lead) & (clock < pause_at + lead + 0.2)
        peer[said] += _voice(clock[said], 150.0, 0.04)
    elif remark == "whispered":
        said = (clock >= pause_at + lead) & (clock < pause_at + lead + 0.2)
        peer[said] += rng.normal(0.0, 0.02, int(said.sum()))
    if remark_db is not None:
        said = (clock >= pause_at + lead) & (clock < pause_at + lead + 0.1)
        peer[said] += 10 ** (remark_db / 20) * np.sqrt(2) * np.sin(2 * np.pi * 200 * clock[said])
    return owner, peer, (3.0, pause_at + pause)


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize("gain", [-20.0, 0.0, 30.0])
@pytest.mark.parametrize("tail", [False, True], ids=["abrupt_bleed", "ringing_bleed"])
@pytest.mark.parametrize("gap_sec", [0.01, 0.03, 0.15])
@pytest.mark.parametrize("kind", ["white", "pink"])
@pytest.mark.parametrize(
    ("remark", "expected"),
    [(None, ()), ("voiced", ("guest",)), ("whispered", ("guest",))],
    ids=["room_only", "voiced_remark", "whispered_remark"],
)
def test_room_between_owner_words_is_clear_and_a_remark_in_it_still_warns(
    tmp_path: Path,
    cached: bool,
    gain: float,
    tail: bool,
    gap_sec: float,
    kind: str,
    remark: str | None,
    expected: tuple[str, ...],
) -> None:
    """#1361: stray frames and the decaying tail of the owner's bleed are not the peer speaking."""
    owner, peer, span = _owner_words_over_room(kind, gap_sec, remark=remark, bleed=0.03, tail=tail)
    p = _project_with_peer_audio(tmp_path, peer)
    _write_wav(tmp_path / "host.wav", owner)
    for track in p.tracks:
        track.gain_db = gain
    caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None

    levels = measure_peer_speech(
        p,
        [span],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
        caches=caches,
    )
    assert levels is not None
    assert levels.speaking == expected
    assert levels.unread == {}


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize("gain", [-20.0, 0.0, 30.0])
def test_remark_that_starts_as_the_owner_word_ends_under_its_bleed_still_warns(
    tmp_path: Path, cached: bool, gain: float
) -> None:
    """The ring after an owner word falls away; a remark that follows it does not."""
    owner, peer, span = _owner_words_over_room(
        "white", 0.0, remark=None, bleed=0.05, tail=True, lead=0.0, remark_db=-42.0
    )
    p = _project_with_peer_audio(tmp_path, peer)
    _write_wav(tmp_path / "host.wav", owner)
    for track in p.tracks:
        track.gain_db = gain
    caches = build_track_rms_caches(p, defaults=load_defaults()) if cached else None

    levels = measure_peer_speech(
        p,
        [(span[1] - 1.5, span[1])],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
        caches=caches,
    )
    assert levels is not None
    assert levels.speaking == ("guest",)
