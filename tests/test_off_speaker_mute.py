from __future__ import annotations

import numpy as np

from podcast_mcp.edits.off_speaker_mute import PeerEvidence, plan_from_evidence
from podcast_mcp.engines.level_profile import LevelProfile

FRAMES_PER_SEC = 100
ROOM = -70.0
SPEECH = -20.0


def _profile() -> LevelProfile:
    return LevelProfile(room_db=ROOM, speech_db=SPEECH, loud_db=SPEECH + 6.0)


def _levels(seconds: float, fill: float = ROOM) -> np.ndarray:
    return np.full(round(seconds * FRAMES_PER_SEC), fill)


def _set(levels: np.ndarray, start: float, end: float, db: float) -> None:
    levels[round(start * FRAMES_PER_SEC) : round(end * FRAMES_PER_SEC)] = db


def _covered(regions: list[dict], t: float) -> bool:
    return any(r["start"] <= t < r["end"] for r in regions)


def _call(*, own_words, peer_words, track, peer):
    return plan_from_evidence(
        "dani",
        track,
        _profile(),
        own_words,
        [PeerEvidence("vicky", peer, _profile(), peer_words)],
    )


def test_bleed_under_the_other_speaker_is_muted_where_the_track_has_no_word():
    peer = _levels(10.0)
    _set(peer, 2.0, 5.0, SPEECH)
    _set(peer, 7.0, 8.0, SPEECH)
    track = _levels(10.0)
    _set(track, 2.0, 5.0, SPEECH - 25.0)
    _set(track, 7.0, 8.0, SPEECH - 25.0)
    plan = _call(
        own_words=[(7.2, 7.8)], peer_words=[(2.0, 5.0), (7.0, 8.0)], track=track, peer=peer
    )
    assert plan.refusal is None
    assert plan.leak_ratio_db == -25.0
    assert _covered(plan.regions, 3.5)
    assert _covered(plan.regions, 2.1)
    assert not _covered(plan.regions, 7.5)
    assert plan.kept_own_word_sec > 0.5


def test_untranscribed_own_sound_under_the_other_speaker_stays_open():
    peer = _levels(10.0)
    _set(peer, 2.0, 6.0, SPEECH)
    track = _levels(10.0)
    _set(track, 2.0, 6.0, SPEECH - 25.0)
    _set(track, 3.5, 4.0, SPEECH - 4.0)
    plan = _call(own_words=[], peer_words=[(2.0, 6.0)], track=track, peer=peer)
    assert not _covered(plan.regions, 3.75)
    assert _covered(plan.regions, 2.5)
    assert _covered(plan.regions, 5.5)
    assert plan.kept_own_energy_sec >= 0.5


def test_own_words_are_never_muted_whatever_their_level():
    peer = _levels(6.0)
    _set(peer, 1.0, 5.0, SPEECH)
    track = _levels(6.0)
    _set(track, 1.0, 5.0, SPEECH - 25.0)
    _set(track, 2.0, 3.0, SPEECH - 40.0)
    plan = _call(own_words=[(2.0, 3.0)], peer_words=[(1.0, 5.0)], track=track, peer=peer)
    assert not _covered(plan.regions, 2.0)
    assert not _covered(plan.regions, 2.99)


def test_a_quiet_track_has_nothing_to_mute():
    peer = _levels(6.0)
    _set(peer, 1.0, 5.0, SPEECH)
    plan = _call(own_words=[], peer_words=[(1.0, 5.0)], track=_levels(6.0), peer=peer)
    assert plan.regions == []
    assert plan.already_quiet_sec > 3.0


def test_no_leak_evidence_refuses_instead_of_guessing():
    peer = _levels(6.0)
    _set(peer, 1.0, 1.4, SPEECH)
    track = _levels(6.0)
    _set(track, 1.0, 1.4, SPEECH - 25.0)
    plan = _call(own_words=[], peer_words=[(1.0, 1.4)], track=track, peer=peer)
    assert plan.regions == []
    assert plan.refusal == "no_leak_evidence"
