"""Speech-energy guard and track-local punch."""

from __future__ import annotations

import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.edits.clips_ops import clips_for_track, punch_timeline_range_from_clips
from podcast_mcp.edits.cut_speech import CutSpeechConfirmation, SpeechClearance, clear_ripple
from podcast_mcp.edits.decisions import approve_edits
from podcast_mcp.edits.ripple import RippleRemoval, TrackExtent, ripple_remove_clips
from podcast_mcp.edits.source_removals import CutScopeHold, consume_source_remove
from podcast_mcp.edits.speech_energy_guard import (
    ResolvedCutScope,
    assess_cross_track_speech,
    measure_peer_speech,
    resolve_cut_scope,
)
from podcast_mcp.edits.timeline_ops import punch_delete
from podcast_mcp.edits.transcript_cuts import add_remove_decision
from podcast_mcp.engines.audio_audit import (
    _played_window,
    build_track_rms_caches,
    measure_timeline_rms_db,
    timeline_frame_levels_db,
)
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.ungated_audio import raw_timeline_samples
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
                        "min_other_rms_db": -42.0,
                    }
                },
                "analysis": {"heuristics": {}},
            },
        )

    assert isinstance(result, ResolvedCutScope)
    assert result.cause == "peer_speech"
    assert result.guard.blocking_track_ids == ("guest",)
    assert result.guard.action == "skip"


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
        resolved = resolve_cut_scope(p, "host", 2.0, 2.5)
        assert isinstance(resolved, ResolvedCutScope)
        scope, guard = resolved.scope, resolved.guard
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
        resolved = resolve_cut_scope(p, "host", 2.0, 2.5)
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
        resolved = resolve_cut_scope(p, "host", 2.0, 2.5)
        assert isinstance(resolved, ResolvedCutScope)
        scope, guard = resolved.scope, resolved.guard
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
        resolved = resolve_cut_scope(p, "host", 2.0, 2.5)
        assert isinstance(resolved, ResolvedCutScope)
        scope, guard = resolved.scope, resolved.guard
    assert scope == "session"
    assert guard is not None
    assert not guard.blocked


def test_resolve_cut_scope_track_scope_short_circuits() -> None:
    p = _two_track()
    resolved = resolve_cut_scope(p, "host", 2.0, 2.5, requested_scope="track")
    assert isinstance(resolved, ResolvedCutScope)
    scope, guard = resolved.scope, resolved.guard
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
    def fake_rms(project, track_id, t0, t1, caches=None):
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


_GUARD_ON = {
    "tighten": {
        "speech_energy_guard": {
            "enabled": True,
            "on_conflict": "track_local",
            "min_other_rms_db": -42.0,
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


def _project_with_peer_audio(tmp_path: Path, peer: np.ndarray) -> EpisodeProject:
    p = _two_track(duration=peer.size / _SR)
    p.meta.workspace_dir = str(tmp_path)
    p.transcripts = []
    signals = {"host": np.zeros_like(peer), "guest": peer}
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

    reference_rms = measure_timeline_rms_db(p, "guest", 0.1, 0.8)
    brief_rms = measure_timeline_rms_db(p, "guest", 3.0, 3.1)
    assert reference_rms is not None
    assert brief_rms == pytest.approx(reference_rms, abs=0.1)

    guard = assess_cross_track_speech(p, "host", 1.0, 6.0, defaults=_GUARD_ON)

    assert guard.other_rms_db["guest"] < -42.0
    assert guard.blocked
    assert guard.blocking_track_ids == ("guest",)
    assert guard.action == "track_local"


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

    attack_rms = measure_timeline_rms_db(p, "guest", 5.98, 6.0)
    following_rms = measure_timeline_rms_db(p, "guest", 6.04, 6.08)
    assert attack_rms is not None
    assert following_rms is not None
    assert attack_rms < -42.0
    assert following_rms > attack_rms + 10.0

    guard = assess_cross_track_speech(p, "host", 1.0, 6.0, defaults=_GUARD_ON)

    assert guard.other_rms_db["guest"] < -42.0
    assert guard.blocked
    assert guard.blocking_track_ids == ("guest",)
    assert guard.action == "track_local"


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
    peer[brief] = 0.0045 * carrier[brief]
    if owner_case == "same_time":
        owner[brief] = 0.1 * carrier[brief]
    else:
        owner[elsewhere] = 0.6 * carrier[elsewhere]
        if owner_case == "loud_copy_elsewhere":
            peer[elsewhere] = 0.3 * carrier[elsewhere]
    p = _project_with_peer_audio(tmp_path, peer)
    _write_wav(tmp_path / "host.wav", owner)
    caches = build_track_rms_caches(p) if cached else None

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
        measure_timeline_rms_db(p, "guest", 1.0, 6.0, caches=caches)
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
    caches = build_track_rms_caches(p) if cached else None

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
    assert guard.action == ("track_local" if expected else None)


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize("dense_bleed", [False, True], ids=["sparse_owner", "dense_bleed"])
def test_quiet_room_after_owner_warns_only_when_bleed_raises_raw_reference(
    tmp_path: Path, cached: bool, dense_bleed: bool
) -> None:
    clock = np.arange(8 * _SR) / _SR
    carrier = np.sin(2 * np.pi * 220 * clock)
    noise = np.random.default_rng(14).normal(0.0, 0.0004, clock.size)
    owner = np.zeros_like(clock)
    peer = noise.copy()
    if dense_bleed:
        owner = 0.6 * carrier
        peer = 0.3 * carrier
        room = (clock >= 3.0) & (clock < 3.1)
        owner[room] = 0.0
        peer[room] = noise[room]
    else:
        burst = (clock >= 2.0) & (clock < 2.1)
        owner[burst] = 0.6 * carrier[burst]
    p = _project_with_peer_audio(tmp_path, peer)
    _write_wav(tmp_path / "host.wav", owner)
    caches = build_track_rms_caches(p) if cached else None

    levels = measure_peer_speech(
        p,
        [(1.0, 6.0)],
        owner_track_ids=["host"],
        peer_track_ids=["guest"],
        defaults=_GUARD_ON,
        caches=caches,
    )
    assert levels is not None
    assert levels.speaking == (("guest",) if dense_bleed else ())
    assert levels.unread == {}
    guard = assess_cross_track_speech(p, "host", 1.0, 6.0, defaults=_GUARD_ON, caches=caches)
    assert guard.blocked is dense_bleed
    assert guard.action == ("track_local" if dense_bleed else None)


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
@pytest.mark.parametrize("gain", [-20.0, 0.0, 30.0])
@pytest.mark.parametrize("silent", [False, True], ids=["noise", "digital_zero"])
def test_noise_without_contrast_uses_mean_while_digital_zero_stays_clear(
    tmp_path: Path, cached: bool, gain: float, silent: bool
) -> None:
    peer = np.zeros(8 * _SR) if silent else np.random.default_rng(14).normal(0.0, 0.0004, 8 * _SR)
    p = _project_with_peer_audio(tmp_path, peer)
    p.tracks[1].gain_db = gain
    p.transcripts = [
        Transcript(track_id="guest", words=[TranscriptWord(text="right", start=3.0, end=3.1)])
    ]
    caches = build_track_rms_caches(p) if cached else None

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
    if not silent and gain == 30.0:
        assert levels.peer_rms_db["guest"] > -42.0
    guard = assess_cross_track_speech(p, "host", 1.0, 6.0, defaults=_GUARD_ON, caches=caches)
    assert guard.blocking_track_ids == expected
    assert guard.action == ("track_local" if expected else None)


@pytest.mark.parametrize("cached", [False, True], ids=["placed", "cached"])
def test_continuous_hot_peer_without_quiet_context_still_blocks(
    tmp_path: Path, cached: bool
) -> None:
    clock = np.arange(8 * _SR) / _SR
    p = _project_with_peer_audio(tmp_path, 0.1 * np.sin(2 * np.pi * 220 * clock))
    caches = build_track_rms_caches(p) if cached else None

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
    caches = build_track_rms_caches(p) if cached else None

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
        ripple_remove_clips(forward, [(start, end)], ["host", "guest"])
        remaining = 0 if edge in ("first_inside", "last_inside") else 1
        assert np.count_nonzero(_played_window(forward, "guest", 0.0, 8.0)) == remaining
        assert np.count_nonzero(raw_timeline_samples(forward, "guest")) == remaining
        caches = build_track_rms_caches(p) if cached else None
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
        before = _played_window(p, "guest", 0.0, 8.50004)
        before_cache = raw_timeline_samples(p, "guest")
        assert np.count_nonzero(before) == np.count_nonzero(before_cache) == 1
        forward = p.model_copy(deep=True)
        ripple_remove_clips(forward, spans, ["host", "guest"])
        expected_count = 0 if removed else 1
        assert np.count_nonzero(_played_window(forward, "guest", 0.0, 6.50004)) == expected_count
        assert np.count_nonzero(raw_timeline_samples(forward, "guest")) == expected_count
        levels = measure_peer_speech(
            p,
            spans,
            owner_track_ids=["host"],
            peer_track_ids=["guest"],
            defaults=_GUARD_ON,
            caches=build_track_rms_caches(p) if cached else None,
            _admissible_spans=spans,
        )
        assert levels is not None
        assert levels.speaking == (("guest",) if removed else ())
        assert levels.unread == {}
        removal = RippleRemoval.of([TrackExtent("host", *spans[0])])
        clearance = clear_ripple(p, removal, confirm_cut_speech=False, defaults=_GUARD_ON)
        assert isinstance(clearance, SpeechClearance) is (not removed)
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
        result = consume_source_remove(
            p,
            edit,
            confirm_cut_speech=False,
            allow_review=True,
            batch=(),
            use_inaudible_opt=False,
            record_log=False,
        )
        if removed:
            assert isinstance(result, CutScopeHold)
            assert result.reason == "peer_speech"
            assert np.array_equal(_played_window(p, "guest", 0.0, 8.50004), before)
            assert isinstance(clearance, CutSpeechConfirmation)
            confirmed = consume_source_remove(
                p,
                edit.model_copy(update={"cut_speech": clearance.speech}),
                confirm_cut_speech=True,
                allow_review=True,
                batch=(),
                use_inaudible_opt=False,
                record_log=False,
            )
            assert isinstance(confirmed, tuple)
            assert np.count_nonzero(_played_window(p, "guest", 0.0, 6.50004)) == 0
            assert np.count_nonzero(raw_timeline_samples(p, "guest")) == 0
        else:
            assert isinstance(result, tuple)
            after = _played_window(p, "guest", 0.0, 6.50004)
            assert np.count_nonzero(after) == 1
            assert after[after != 0].tolist() == before[before != 0].tolist()


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
        ripple_remove_clips(forward, [span], ["host", "guest"])
        assert np.count_nonzero(raw_timeline_samples(forward, "guest")) == (0 if removed else 1)
        caches = build_track_rms_caches(p)
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
    peer[voice] = 0.01 * np.sin(2 * np.pi * 220 * clock[voice])
    p = _project_with_peer_audio(tmp_path, peer)
    p.clips[1].source_start = p.clips[1].timeline_start = 4.0
    p.clips[1].source_end = 4.5 if gap else 6.0
    if gap:
        p.clips.append(
            Clip(id="g2", track_id="guest", source_start=4.89, source_end=6.0, timeline_start=4.89)
        )
    caches = build_track_rms_caches(p) if cached else None
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
    p = _project_with_peer_audio(tmp_path, amplitude * np.sin(2 * np.pi * 220 * clock))
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
    peer[brief] = 0.0045 * carrier[brief]
    p = _project_with_peer_audio(tmp_path, peer)
    _write_wav(tmp_path / "host.wav", owner)
    p.clips[0].source_end = 2.0
    p.clips.insert(
        1,
        Clip(id="h2", track_id="host", source_start=16.0, source_end=20.0, timeline_start=16.0),
    )
    caches = build_track_rms_caches(p) if cached else None

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
        measure_timeline_rms_db(p, "guest", 1.0, 2.0, caches=caches)
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

    def read(project, track_id, start, end, *, frame_sec, hop_sec, caches):
        requests.append((track_id, start, end))
        if start < 0.94 or end > 15.06:
            return None
        assert frame_sec == hop_sec == 0.01
        return timeline_frame_levels_db(
            project, track_id, start, end, frame_sec=frame_sec, hop_sec=hop_sec, caches=caches
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
    assert guard.action == "track_local"


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
