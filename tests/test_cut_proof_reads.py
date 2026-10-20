from __future__ import annotations

from types import SimpleNamespace

import numpy as np
import pytest

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.cut_proof import (
    BatchTimelineEvidence,
    CutEffect,
    shared_timeline_rms_caches,
)
from podcast_mcp.engines.audio_audit import TimelineReads, TrackRmsCache, TrackRmsCacheSet
from podcast_mcp.engines.level_profile import PROFILE_TOLERANCE_DB, track_profile
from podcast_mcp.util.batch_scope import frozen_state

RATE = 8000
SECONDS = 1800


def _speechlike(seed: int) -> np.ndarray:
    """Bursts of tone at varied levels over room noise: every percentile of it is dense."""
    rng = np.random.default_rng(seed)
    gains = 10 ** (rng.uniform(-60, -15, SECONDS * 10) / 20)
    envelope = np.repeat(gains, RATE // 10)
    return (rng.normal(0, 1, SECONDS * RATE) * envelope).astype(np.float32)


class _World:
    """The timeline a render would hold for each track, and the builds that measured it."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch, tracks: dict[str, np.ndarray]) -> None:
        self.tracks = tracks
        self.builds: list[dict[str, int]] = []
        self.evidence_held_old_set_at_build: list[bool] = []
        self.evidence: BatchTimelineEvidence | None = None

        def build(_project: object, _defaults: object) -> TrackRmsCacheSet:
            if self.evidence is not None:
                self.evidence_held_old_set_at_build.append(self.evidence._caches is not None)
            self.builds.append({tid: a.size for tid, a in self.tracks.items()})
            return TrackRmsCacheSet(
                caches={
                    tid: TrackRmsCache(samples=a.copy(), sample_rate=RATE)
                    for tid, a in self.tracks.items()
                }
            )

        monkeypatch.setattr("podcast_mcp.edits.cut_proof._build_timeline_rms_caches", build)

    def ripple(self, start: float, end: float) -> None:
        """Close up the span; a render also fades the audio around the join, which a cut of
        the cached samples does not know."""
        at = round(start * RATE)
        for tid, a in self.tracks.items():
            joined = np.concatenate((a[:at], a[round(end * RATE) :]))
            joined[at - 40 : at + 40] *= 0.25
            self.tracks[tid] = joined

    def punch(self, track_id: str, start: float, end: float) -> None:
        self.tracks[track_id][round(start * RATE) : round(end * RATE)] = 0


def _profiles(caches: TrackRmsCacheSet) -> dict[str, tuple[float, float, float]]:
    return {
        tid: (c.profile.room_db, c.profile.speech_db, c.profile.loud_db)
        for tid, c in caches.caches.items()
    }


def _read_profiles(caches: TrackRmsCacheSet) -> dict[str, tuple[float, float, float]]:
    return _profiles(caches)


def _fresh(world: _World) -> dict[str, tuple[float, float, float]]:
    return {
        tid: (p.room_db, p.speech_db, p.loud_db)
        for tid, a in world.tracks.items()
        for p in [track_profile(a, RATE)]
    }


def _assert_close(got: dict, want: dict) -> None:
    assert got.keys() == want.keys()
    for tid in want:
        assert got[tid] == pytest.approx(want[tid], abs=PROFILE_TOLERANCE_DB), tid


def _two_tracks(monkeypatch: pytest.MonkeyPatch) -> tuple[_World, BatchTimelineEvidence]:
    world = _World(monkeypatch, {"host": _speechlike(1), "guest": _speechlike(2)})
    evidence = BatchTimelineEvidence({})
    world.evidence = evidence
    return world, evidence


def test_shared_timeline_rms_caches_decodes_once_per_proof_block(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    builds: list[int] = []

    def fake_build(_project: object, **kwargs: object) -> TrackRmsCacheSet:
        builds.append(len(builds) + 1)
        return TrackRmsCacheSet()

    monkeypatch.setattr("podcast_mcp.edits.cut_proof.build_track_rms_caches", fake_build)
    monkeypatch.setattr("podcast_mcp.edits.cut_proof.dialogue_track_ids", lambda _p: [])
    project = SimpleNamespace()

    with frozen_state():
        first = shared_timeline_rms_caches(project, defaults=load_defaults())  # type: ignore[arg-type]
        again = shared_timeline_rms_caches(project, defaults=load_defaults())  # type: ignore[arg-type]

    assert first is again
    assert builds == [1]

    shared_timeline_rms_caches(project, defaults=load_defaults())  # type: ignore[arg-type]
    assert builds == [1, 2]


def _read_until(end_sec: float):
    def read(caches: TrackRmsCacheSet) -> float | None:
        return caches.caches["host"].rms_db(end_sec - 5, end_sec)

    return read


def _cut(start: float, *, fade: float = 0.0, length: float = 0.4) -> CutEffect:
    return CutEffect(start, start + length, ("host", "guest"), fade_sec=fade)


def _apply(world: _World, evidence: BatchTimelineEvidence, effect: CutEffect) -> SimpleNamespace:
    """The batch's cut: the world's tracks change and the evidence is told what changed."""
    after = SimpleNamespace()
    world.ripple(effect.start_sec, effect.end_sec)
    evidence.applied(after, effect)  # type: ignore[arg-type]
    return after


def test_batch_evidence_serves_cuts_before_the_first_move_from_one_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world, evidence = _two_tracks(monkeypatch)
    project = SimpleNamespace()

    evidence.observe(project, _read_until(20))  # type: ignore[arg-type]
    project = _apply(world, evidence, _cut(60.0))
    evidence.observe(project, _read_until(40))  # type: ignore[arg-type]
    project = _apply(world, evidence, _cut(45.0))
    evidence.observe(project, _read_until(38))  # type: ignore[arg-type]

    assert len(world.builds) == 1


def test_batch_evidence_measures_again_when_a_read_reaches_what_a_cut_moved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world, evidence = _two_tracks(monkeypatch)
    project = SimpleNamespace()
    evidence.observe(project, _read_until(20))  # type: ignore[arg-type]
    project = _apply(world, evidence, _cut(60.0))

    evidence.observe(project, _read_until(59.5))  # type: ignore[arg-type]
    assert len(world.builds) == 2

    # The new build matches the current timeline, so it serves reads anywhere again.
    evidence.observe(project, _read_until(90))  # type: ignore[arg-type]
    assert len(world.builds) == 2


def test_batch_evidence_answers_from_the_rebuilt_caches_not_the_first_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world, evidence = _two_tracks(monkeypatch)
    project = SimpleNamespace()
    evidence.observe(project, _read_until(20))  # type: ignore[arg-type]
    project = _apply(world, evidence, _cut(60.0, length=3.0))

    def join(caches: TrackRmsCacheSet) -> float | None:
        return caches.caches["host"].rms_db(59.99, 60.01)

    got = evidence.observe(project, join)  # type: ignore[arg-type]

    assert got == TrackRmsCache(samples=world.tracks["host"], sample_rate=RATE).rms_db(59.99, 60.01)
    assert len(world.builds) == 2


def test_batch_evidence_counts_the_fade_a_cut_writes_before_its_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world, evidence = _two_tracks(monkeypatch)
    project = SimpleNamespace()
    evidence.observe(project, _read_until(20))  # type: ignore[arg-type]
    project = _apply(world, evidence, _cut(60.0, fade=0.1))

    evidence.observe(project, _read_until(58.95))  # type: ignore[arg-type]
    assert len(world.builds) == 2


def test_a_read_just_before_a_cut_without_a_fade_needs_no_new_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world, evidence = _two_tracks(monkeypatch)
    project = SimpleNamespace()
    evidence.observe(project, _read_until(20))  # type: ignore[arg-type]
    project = _apply(world, evidence, _cut(60.0))

    evidence.observe(project, _read_until(58.95))  # type: ignore[arg-type]
    assert len(world.builds) == 1


def test_the_earliest_move_of_the_batch_decides_what_a_read_may_reach(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cuts need not come in timeline order (another track's offset reorders them)."""
    world, evidence = _two_tracks(monkeypatch)
    project = SimpleNamespace()
    evidence.observe(project, _read_until(20))  # type: ignore[arg-type]
    project = _apply(world, evidence, _cut(100.0))
    evidence.observe(project, _read_until(30))  # type: ignore[arg-type]
    project = _apply(world, evidence, _cut(300.0))

    evidence.observe(project, _read_until(150))  # type: ignore[arg-type]

    assert len(world.builds) == 2


def test_the_profile_follows_a_ripple_cut_without_measuring_the_timeline_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world, evidence = _two_tracks(monkeypatch)
    project = SimpleNamespace()
    evidence.observe(project, _read_until(20))  # type: ignore[arg-type]
    before = _fresh(world)

    project = _apply(world, evidence, _cut(300.0, length=12.0))
    got = evidence.observe(project, _read_profiles)  # type: ignore[arg-type]

    assert len(world.builds) == 1
    assert got != before
    _assert_close(got, _fresh(world))


def test_the_profile_follows_a_punch_and_a_pad(monkeypatch: pytest.MonkeyPatch) -> None:
    world, evidence = _two_tracks(monkeypatch)
    project = SimpleNamespace()
    evidence.observe(project, _read_until(20))  # type: ignore[arg-type]

    world.punch("host", 400.0, 430.0)
    after = SimpleNamespace()
    evidence.applied(after, CutEffect(400.0, 430.0, ("host",), hole=True))
    _assert_close(evidence.observe(after, _read_profiles), _fresh(world))  # type: ignore[arg-type]

    world.ripple(200.0, 200.4)
    for tid in world.tracks:
        world.tracks[tid] = np.concatenate(
            (
                world.tracks[tid][: 200 * RATE],
                np.zeros(round(0.25 * RATE), dtype=np.float32),
                world.tracks[tid][200 * RATE :],
            )
        )
    padded = SimpleNamespace()
    evidence.applied(
        padded, CutEffect(200.0, 200.4, ("host", "guest"), pad_sec=0.25, pad_silent=True)
    )
    _assert_close(evidence.observe(padded, _read_profiles), _fresh(world))  # type: ignore[arg-type]
    assert len(world.builds) == 1


def test_a_track_the_cut_did_not_move_keeps_its_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    world, evidence = _two_tracks(monkeypatch)
    project = SimpleNamespace()
    first = evidence.observe(project, _read_profiles)  # type: ignore[arg-type]

    world.tracks["host"] = np.concatenate(
        (world.tracks["host"][: 100 * RATE], world.tracks["host"][105 * RATE :])
    )
    after = SimpleNamespace()
    evidence.applied(after, CutEffect(100.0, 105.0, ("host",)))
    got = evidence.observe(after, _read_profiles)  # type: ignore[arg-type]

    assert got["guest"] == first["guest"]
    assert got["host"] != first["host"]


def test_a_cut_that_was_not_kept_leaves_the_evidence_as_it_was(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world, evidence = _two_tracks(monkeypatch)
    project = SimpleNamespace()
    first = evidence.observe(project, _read_profiles)  # type: ignore[arg-type]

    evidence.applied(SimpleNamespace(), _cut(300.0, length=12.0))  # the caller dropped it
    got = evidence.observe(project, _read_profiles)  # type: ignore[arg-type]

    assert got == first
    assert len(world.builds) == 1
    # and the next cut that is kept is measured against the unchanged timeline
    kept = _apply(world, evidence, _cut(200.0, length=12.0))
    _assert_close(evidence.observe(kept, _read_profiles), _fresh(world))  # type: ignore[arg-type]
    assert len(world.builds) == 1


def test_a_project_the_evidence_did_not_follow_is_measured_from_scratch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world, evidence = _two_tracks(monkeypatch)
    evidence.observe(SimpleNamespace(), _read_until(20))  # type: ignore[arg-type]

    evidence.observe(SimpleNamespace(), _read_until(20))  # type: ignore[arg-type]

    assert len(world.builds) == 2


def test_a_cut_the_evidence_cannot_follow_is_measured_from_scratch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world, evidence = _two_tracks(monkeypatch)
    evidence.observe(SimpleNamespace(), _read_until(20))  # type: ignore[arg-type]
    after = SimpleNamespace()
    world.ripple(300.0, 301.0)
    evidence.applied(after, None)

    evidence.observe(after, _read_until(20))  # type: ignore[arg-type]

    assert len(world.builds) == 2


def test_the_timeline_is_measured_again_once_the_guessed_frames_could_move_the_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world, evidence = _two_tracks(monkeypatch)
    project = SimpleNamespace()
    evidence.observe(project, _read_until(20))  # type: ignore[arg-type]

    # A pad is guessed frame by frame: 20 s of it could move any percentile of a 10 min track.
    after = SimpleNamespace()
    world.ripple(300.0, 300.4)
    evidence.applied(after, CutEffect(300.0, 300.4, ("host", "guest"), pad_sec=20.0))
    evidence.observe(after, _read_until(20))  # type: ignore[arg-type]
    assert len(world.builds) == 2

    # the new build holds no guesses, so the next observation reads it as it is
    evidence.observe(after, _read_until(20))  # type: ignore[arg-type]
    assert len(world.builds) == 2

    # and a small cut after it is followed without another build
    after = _apply(world, evidence, _cut(200.0))
    evidence.observe(after, _read_until(20))  # type: ignore[arg-type]
    assert len(world.builds) == 2


def test_the_old_caches_are_released_before_the_next_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    world, evidence = _two_tracks(monkeypatch)
    project = SimpleNamespace()
    evidence.observe(project, _read_until(20))  # type: ignore[arg-type]
    project = _apply(world, evidence, _cut(60.0))
    evidence.observe(project, _read_until(59.5))  # type: ignore[arg-type]

    assert world.evidence_held_old_set_at_build == [False, False]


def test_a_batch_does_not_serve_whole_track_measures_it_does_not_carry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _world, evidence = _two_tracks(monkeypatch)

    def read(caches: TrackRmsCacheSet) -> object:
        with pytest.raises(RuntimeError, match="carry window reads and level profiles only"):
            caches.echo_pairs()
        with pytest.raises(RuntimeError):
            caches.bleed_paths("host")
        with pytest.raises(RuntimeError):
            caches.copy_match("host", "guest", 0.0, 1.0)
        return caches.caches["host"].profile

    assert evidence.observe(SimpleNamespace(), read)  # type: ignore[arg-type]


def test_timeline_reads_keep_the_latest_second_read() -> None:
    cache = TrackRmsCache(samples=np.zeros(RATE * 20, dtype=np.float32), sample_rate=RATE)
    reads = TimelineReads()
    cache.reads = reads

    cache.rms_db(8, 10)
    cache.rms_db(1, 2)

    assert reads.end_sec == 10
    reads.reset()
    assert reads.end_sec == -np.inf
