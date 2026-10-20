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
    _set(track, 7.2, 7.8, SPEECH - 4.0)
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


def test_sound_that_does_not_follow_the_other_speaker_is_not_a_copy():
    rng = np.random.default_rng(3)
    peer = _levels(10.0)
    track = _levels(10.0)
    _set(peer, 2.0, 8.0, SPEECH)
    peer[200:800] += rng.uniform(-8.0, 0.0, size=600)
    track[:] = SPEECH - 25.0 + rng.uniform(-8.0, 0.0, size=track.size)
    plan = _call(own_words=[], peer_words=[(2.0, 8.0)], track=track, peer=peer)
    assert plan.regions == []
    assert plan.refusal == "no_copy_evidence"
    assert plan.kept_uncorrelated_sec > 5.0


def test_a_copy_that_follows_the_other_speaker_is_muted_even_when_quiet():
    rng = np.random.default_rng(5)
    peer = _levels(10.0)
    _set(peer, 2.0, 8.0, SPEECH)
    peer[200:800] += rng.uniform(-8.0, 0.0, size=600)
    track = _levels(10.0)
    track[200:800] = peer[200:800] - 40.0
    plan = _call(own_words=[], peer_words=[(2.0, 8.0)], track=track, peer=peer)
    assert plan.leak_ratio_db == -40.0
    assert _covered(plan.regions, 5.0)


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


def _speechlike(rng: np.random.Generator, seconds: float, rate: int) -> np.ndarray:
    """Noise whose level moves in 80 ms steps, like syllables."""
    steps = rng.uniform(0.15, 1.0, size=int(seconds / 0.08) + 1)
    envelope = np.repeat(steps, int(0.08 * rate))[: int(seconds * rate)]
    return rng.standard_normal(envelope.size) * envelope * 0.2


def _write_wav(path, samples: np.ndarray, rate: int) -> None:
    import wave

    pcm = np.clip(samples, -1.0, 1.0)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes((pcm * 32767).astype("<i2").tobytes())


def test_service_mutes_the_copy_and_leaves_the_guests_words(tmp_path):
    from podcast_mcp.models import (
        Clip,
        EpisodeProject,
        MediaAsset,
        Track,
        TrackRole,
        Transcript,
        TranscriptWord,
    )
    from podcast_mcp.project.store import save_project
    from podcast_mcp.services.app.workspace import ProjectWorkspace
    from podcast_mcp.services.document.analysis import AnalysisService

    rate, seconds = 16000, 12
    rng = np.random.default_rng(7)
    host = np.zeros(rate * seconds)
    guest = np.zeros(rate * seconds)
    for a, b in ((1.0, 4.0), (8.0, 10.0)):
        voice = _speechlike(rng, b - a, rate)
        lo, hi = round(a * rate), round(b * rate)
        host[lo:hi] = voice
        guest[lo + 320 : hi + 320] += voice[: hi - lo] * 0.04
    own = _speechlike(rng, 1.0, rate) * 2.0
    guest[6 * rate : 7 * rate] = own
    room = rng.standard_normal(host.size) * 1e-4
    raw = tmp_path / "raw"
    raw.mkdir()
    _write_wav(raw / "host.wav", host + room, rate)
    _write_wav(raw / "guest.wav", guest + room, rate)

    project = EpisodeProject.create("ep", str(tmp_path))
    project.ensure_dirs()
    for tid in ("host", "guest"):
        project.timeline.tracks.append(
            Track(
                id=tid,
                label=tid,
                role=TrackRole.DIALOGUE,
                speaker=tid.title(),
                media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=float(seconds)),
            )
        )
        project.timeline.clips.append(
            Clip(
                id=f"c-{tid}",
                track_id=tid,
                source_start=0.0,
                source_end=float(seconds),
                timeline_start=0.0,
            )
        )
    spoken = [round(a + 0.4 * k, 2) for a, n in ((1.0, 7), (8.0, 5)) for k in range(n)]
    host_words = [TranscriptWord(text="w", start=a, end=a + 0.35) for a in spoken]
    guest_words = [TranscriptWord(text="mine", start=6.1, end=6.9)] + [
        TranscriptWord(text="bleed", start=a, end=a + 0.35, suppressed=True) for a in spoken[:7]
    ]
    project.transcripts = [
        Transcript(track_id="host", words=host_words),
        Transcript(track_id="guest", words=guest_words),
    ]
    path = save_project(project)
    ws = ProjectWorkspace.open(path)

    preview = AnalysisService(ws).mute_off_speaker(track_id="guest", apply=False)
    assert preview["dry_run"] is True and preview["region_count"] >= 1
    assert preview["own_word_overlap_sec"] == 0

    result = AnalysisService(ws).mute_off_speaker(track_id="guest", apply=True)
    assert result["applied_count"] == preview["region_count"]
    assert result["held"] == []

    regions = [
        r for c in ws.project.clips if c.track_id == "guest" for r in c.off_speaker_mute_regions
    ]
    assert regions
    assert all(r.end_s <= 5.0 or r.start_s >= 7.5 for r in regions)
    assert not any(r.start_s < 6.9 and r.end_s > 6.1 for r in regions)
    assert all(not c.mute_regions for c in ws.project.clips if c.track_id == "host")


def test_a_clap_between_the_other_speakers_words_is_held_closed():
    rng = np.random.default_rng(11)
    peer = _levels(10.0)
    _set(peer, 2.0, 8.0, SPEECH)
    peer[200:800] += rng.uniform(-8.0, 0.0, size=600)
    track = _levels(10.0)
    track[200:800] = peer[200:800] - 40.0
    words = [(2.0, 4.8), (5.2, 8.0)]
    plan = _call(own_words=[], peer_words=words, track=track, peer=peer)
    assert _covered(plan.regions, 5.0)
    assert len(plan.regions) == 1
    assert plan.still_audible_sec < 0.2


def test_a_gap_with_the_guests_own_word_stays_open_and_is_reported():
    rng = np.random.default_rng(13)
    peer = _levels(10.0)
    _set(peer, 2.0, 8.0, SPEECH)
    peer[200:800] += rng.uniform(-8.0, 0.0, size=600)
    track = _levels(10.0)
    track[200:800] = peer[200:800] - 40.0
    _set(track, 4.9, 5.1, SPEECH - 4.0)
    plan = _call(own_words=[(4.9, 5.1)], peer_words=[(2.0, 8.0)], track=track, peer=peer)
    assert not _covered(plan.regions, 5.0)
    assert [g["reason"] for g in plan.kept_gaps] == ["own_word"]


def test_rerun_after_apply_finds_nothing_more_and_counts_nothing_audible():
    from podcast_mcp.edits.off_speaker_mute import plan_from_evidence as plan_it

    rng = np.random.default_rng(17)
    peer = _levels(10.0)
    _set(peer, 2.0, 8.0, SPEECH)
    peer[200:800] += rng.uniform(-8.0, 0.0, size=600)
    track = _levels(10.0)
    track[200:800] = peer[200:800] - 40.0
    first = plan_it(
        "dani", track, _profile(), [], [PeerEvidence("vicky", peer, _profile(), [(2.0, 8.0)])]
    )
    played = track.copy()
    for r in first.regions:
        played[round(r["start"] * 100) : round(r["end"] * 100)] = -120.0
    again = plan_it(
        "dani",
        track,
        _profile(),
        [],
        [PeerEvidence("vicky", peer, _profile(), [(2.0, 8.0)])],
        played,
    )
    assert first.regions and again.regions == []
    assert again.still_audible_sec == 0.0
    assert again.leak_ratio_db == first.leak_ratio_db


def test_rerun_closes_a_sliver_left_between_earlier_regions():
    rng = np.random.default_rng(19)
    peer = _levels(10.0)
    _set(peer, 2.0, 8.0, SPEECH)
    peer[200:800] += rng.uniform(-8.0, 0.0, size=600)
    track = _levels(10.0)
    track[200:800] = peer[200:800] - 40.0
    played = track.copy()
    played[200:483] = -120.0
    played[517:800] = -120.0
    plan = _call_played(track, peer, played)
    assert _covered(plan.regions, 5.0)
    assert plan.still_audible_sec < 0.1


def _call_played(track, peer, played):
    return plan_from_evidence(
        "dani",
        track,
        _profile(),
        [],
        [PeerEvidence("vicky", peer, _profile(), [(2.0, 8.0)])],
        played,
    )


def test_own_words_are_read_on_the_timeline_clock_across_clips():
    from podcast_mcp.engines.transcript_gated_play import word_intervals
    from podcast_mcp.models import (
        Clip,
        EpisodeProject,
        MediaAsset,
        Track,
        TrackRole,
        Transcript,
        TranscriptWord,
    )

    project = EpisodeProject.create("ep", "/tmp/offspk-clock")
    project.timeline.tracks.append(
        Track(
            id="dani",
            label="Dani",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/dani.wav", duration_sec=20.0),
        )
    )
    project.timeline.clips += [
        Clip(id="a", track_id="dani", source_start=0.0, source_end=2.0, timeline_start=0.0),
        Clip(id="b", track_id="dani", source_start=10.0, source_end=12.0, timeline_start=2.0),
    ]
    project.transcripts = [
        Transcript(
            track_id="dani",
            words=[
                TranscriptWord(text="one", start=0.5, end=0.9),
                TranscriptWord(text="two", start=10.5, end=10.9),
                TranscriptWord(text="cut", start=5.0, end=5.4),
            ],
        )
    ]
    spans = word_intervals(project, "dani", 0.0, 4.0, merge_gap_sec=0.0)
    assert [(round(a, 2), round(b, 2)) for a, b in spans] == [(0.5, 0.9), (2.5, 2.9)]


def _word_case(*, word_db_over_peer: float | None, follows: bool):
    rng = np.random.default_rng(23)
    peer = _levels(12.0)
    _set(peer, 2.0, 10.0, SPEECH)
    peer[200:1000] += rng.uniform(-8.0, 0.0, size=800)
    track = _levels(12.0)
    track[200:1000] = peer[200:1000] - 40.0
    if word_db_over_peer is not None:
        track[590:610] = peer[590:610] + word_db_over_peer
    if not follows:
        track[550:650] = SPEECH - 10.0 + rng.uniform(-10.0, 0.0, size=100)
    words = [(2.0, 2.4), (5.9, 6.1), (9.6, 10.0)]
    return plan_from_evidence(
        "dani",
        track,
        _profile(),
        words,
        [PeerEvidence("vicky", peer, _profile(), [(2.0, 10.0)])],
    )


def test_a_short_isolated_word_that_is_a_copy_is_released_and_muted():
    plan = _word_case(word_db_over_peer=-40.0, follows=True)
    verdicts = {(j["start"], j["end"]): j["verdict"] for j in plan.judged_words}
    assert verdicts[(5.9, 6.1)] == "copy"
    assert _covered(plan.regions, 6.0)
    assert plan.own_word_overlap_sec == 0.0


def test_a_short_isolated_word_louder_than_a_copy_stays_and_is_not_muted():
    plan = _word_case(word_db_over_peer=-5.0, follows=False)
    assert all(j["verdict"] != "copy" for j in plan.judged_words)
    assert not _covered(plan.regions, 6.0)


def test_judged_words_report_how_far_over_a_copy_they_are():
    plan = _word_case(word_db_over_peer=-40.0, follows=True)
    word = next(j for j in plan.judged_words if (j["start"], j["end"]) == (5.9, 6.1))
    assert word["over_copy_db"] == round(word["level_over_peer_db"] - plan.leak_ratio_db, 1)


def test_own_sound_in_a_pause_of_the_other_speaker_is_kept():
    rng = np.random.default_rng(29)
    peer = _levels(12.0)
    _set(peer, 1.0, 5.0, SPEECH)
    _set(peer, 5.6, 10.0, SPEECH)
    peer[100:1000] += rng.uniform(-8.0, 0.0, size=900)
    track = _levels(12.0)
    track[100:500] = peer[100:500] - 40.0
    track[560:1000] = peer[560:1000] - 40.0
    _set(track, 5.1, 5.3, SPEECH - 30.0)
    plan = _call(own_words=[], peer_words=[(1.0, 5.0), (5.6, 10.0)], track=track, peer=peer)
    assert not _covered(plan.regions, 5.2)
    assert _covered(plan.regions, 3.0)
