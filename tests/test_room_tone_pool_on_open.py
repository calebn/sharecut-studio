"""A project opened at a new path gets its room-tone pools in the background, batch-safe (#2882)."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from podcast_mcp.engines import room_tone
from podcast_mcp.engines.room_tone import room_tone_span
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.batch_scope import batch_scope, unscoped
from podcast_mcp.util.process import current_niceness
from podcast_mcp.util.project_state import project_state_lock
from test_room_tone import _host_audio, _noise
from test_room_tone import _project as _room_project

pytestmark = pytest.mark.usefixtures("real_room_tone_scheduling")


def _join_pools() -> None:
    for thread in threading.enumerate():
        if thread.name.startswith("room-tone-pool-"):
            thread.join(60)


def _two_speakers(tmp_path: Path) -> EpisodeProject:
    return _room_project(tmp_path, host=_host_audio(), guest=_noise(-64.0, seed=2))


def _at_pool_priority() -> bool:
    """On the pool thread or one of its workers: both run at the pool's lowered priority."""
    return current_niceness() > 0


class _Block:
    """Holds the pool thread at the start of its recording until released."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.started, self.release = threading.Event(), threading.Event()
        self.projects: list[EpisodeProject] = []
        self.recordings = 0
        real = room_tone._no_foreign_voice

        def gate(project: EpisodeProject, track_id: str):
            if _at_pool_priority():
                self.recordings += 1
                self.projects.append(project)
                self.started.set()
                self.release.wait(60)
            return real(project, track_id)

        monkeypatch.setattr(room_tone, "_no_foreign_voice", gate)


def _cut(project: EpisodeProject, at: float, track_id: str = "host"):
    return room_tone_span(
        project, track_id, near_sec=at, near_source_id=None, timeline_sec=at, duration_sec=0.3
    )


def test_a_pool_landing_mid_batch_is_first_used_by_the_next_batch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    with batch_scope():
        expected = (_cut(live, 9.0), _cut(live, 4.25))
    block = _Block(monkeypatch)

    assert room_tone.schedule_room_tone_pool(live, "host") is True
    assert block.started.wait(30)
    with batch_scope():
        first = _cut(live, 9.0)
        block.release.set()
        _join_pools()
        # The pool is on disk now, but this batch began without it.
        with unscoped():
            assert room_tone.read_room_tone_pool(live, "host") is not None
        assert room_tone.read_room_tone_pool(live, "host") is None
        second = _cut(live, 4.25)

    assert (first, second) == expected
    picks = [0]
    real = room_tone._pick_sample

    def counted(*args, **kwargs):
        picks[0] += 1
        return real(*args, **kwargs)

    monkeypatch.setattr(room_tone, "_pick_sample", counted)
    with batch_scope():
        pooled = _cut(live, 4.25)
    assert picks == [0]
    assert pooled != expected[1], "the pooled pick must differ from the live one for this test"


def test_the_pool_digest_of_a_batch_does_not_change_when_a_pool_lands(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    block = _Block(monkeypatch)
    assert room_tone.schedule_room_tone_pool(live, "host") is True
    assert block.started.wait(30)
    with batch_scope():
        before = room_tone.room_tone_pool_digest(live)
        block.release.set()
        _join_pools()
        assert room_tone.room_tone_pool_digest(live) == before == ""
    assert room_tone.room_tone_pool_digest(live) != ""


@pytest.mark.parametrize("entry", ["track", "all"])
def test_the_pool_thread_records_from_its_own_copy_of_the_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, entry: str
) -> None:
    live = _two_speakers(tmp_path / "live")
    before = live.model_copy(deep=True)
    reference = _two_speakers(tmp_path / "ref")
    expected = room_tone.record_room_tone_pool(reference, "host")
    assert expected
    block = _Block(monkeypatch)

    if entry == "track":
        assert room_tone.schedule_room_tone_pool(live, "host") is True
    else:
        assert room_tone.schedule_room_tone_pools(live) == 2
    assert block.started.wait(30)
    assert block.projects[0] is not live
    live.tracks[:] = []
    live.clips[:] = []
    block.release.set()
    _join_pools()

    assert room_tone.read_room_tone_pool(before, "host") == expected


def test_a_pool_is_recorded_in_the_workspace_even_while_a_save_shows_the_portable_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # save_project swaps meta.workspace_dir to "." while it writes: a thread that read the live
    # project then resolved the record path against the process's cwd (the repo under pytest).
    live = _two_speakers(tmp_path / "ws")
    cwd = tmp_path / "cwd"
    cwd.mkdir()
    monkeypatch.chdir(cwd)
    block = _Block(monkeypatch)
    assert room_tone.schedule_room_tone_pool(live, "host") is True
    assert block.started.wait(30)
    live.meta.workspace_dir = "."
    block.release.set()
    _join_pools()
    live.meta.workspace_dir = str(tmp_path / "ws")

    assert not list(cwd.rglob("*.json"))
    assert list((tmp_path / "ws" / "artifacts" / "room_tone_pools").glob("*.json"))
    live.meta.workspace_dir = "."
    assert room_tone.schedule_room_tone_pools(live) == 0


def test_a_project_showing_the_portable_directory_queues_nothing_even_with_pools_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    monkeypatch.chdir(tmp_path)
    live.meta.workspace_dir = "."

    assert room_tone.schedule_room_tone_pools(live) == 0
    assert not room_tone._PENDING_POOLS
    assert not [t for t in threading.enumerate() if t.name.startswith("room-tone-pool-")]


def test_scheduling_waits_for_no_one_when_the_project_is_locked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    monkeypatch.setattr(room_tone, "POOL_SNAPSHOT_LOCK_SEC", 0.1)
    held, release = threading.Event(), threading.Event()

    def hold() -> None:
        with project_state_lock(live):
            held.set()
            release.wait(60)

    holder = threading.Thread(target=hold)
    holder.start()
    assert held.wait(10)
    try:
        started = time.monotonic()
        assert room_tone.schedule_room_tone_pools(live) == 0
        assert time.monotonic() - started < 5
        assert not room_tone._PENDING_POOLS
    finally:
        release.set()
        holder.join()
    assert room_tone.schedule_room_tone_pools(live) == 2


def test_a_failed_thread_start_leaves_no_pending_key_and_a_later_schedule_queues(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    real_start = threading.Thread.start

    def refuse(self: threading.Thread) -> None:
        if self.name.startswith("room-tone-pool-"):
            raise RuntimeError("can't start new thread")
        real_start(self)

    monkeypatch.setattr(threading.Thread, "start", refuse)
    assert room_tone.schedule_room_tone_pools(live) == 0
    assert room_tone.schedule_room_tone_pool(live, "host") is False
    assert not room_tone._PENDING_POOLS

    monkeypatch.undo()
    assert room_tone.schedule_room_tone_pools(live) == 2
    _join_pools()
    assert room_tone.read_room_tone_pool(live, "host") is not None


def _assert_preparation_can_retry(
    live: EpisodeProject, foreign: room_tone.PoolKey, track_ids: tuple[str, ...] = ("host", "guest")
) -> None:
    assert set(room_tone._PENDING_POOLS) == {foreign}
    acquired: list[bool] = []

    def probe() -> None:
        lock = project_state_lock(live)
        got = lock.acquire(blocking=False)
        acquired.append(got)
        if got:
            lock.release()

    thread = threading.Thread(target=probe)
    thread.start()
    thread.join(10)
    assert not thread.is_alive()
    assert acquired == [True]
    assert room_tone.schedule_room_tone_pools(live) == len(track_ids)
    _join_pools()
    assert set(room_tone._PENDING_POOLS) == {foreign}
    for track_id in track_ids:
        assert room_tone.read_room_tone_pool(live, track_id)


def _foreign_pending(tmp_path: Path) -> room_tone.PoolKey:
    foreign = room_tone._pool_key(_two_speakers(tmp_path / "foreign"), "host")
    assert foreign is not None
    room_tone._PENDING_POOLS.add(foreign)
    return foreign


@pytest.mark.parametrize("failure", [KeyboardInterrupt, SystemExit, RuntimeError])
@pytest.mark.parametrize("owned", [False, True])
def test_failed_pool_snapshot_releases_only_its_claims_and_can_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: type[BaseException], owned: bool
) -> None:
    live = _two_speakers(tmp_path / "live")
    foreign = _foreign_pending(tmp_path)
    error = failure("snapshot interrupted")

    def fail_snapshot(*args, **kwargs):
        raise error

    with monkeypatch.context() as fault:
        fault.setattr(EpisodeProject, "model_copy", fail_snapshot)
        if isinstance(error, Exception):
            assert room_tone.schedule_room_tone_pools(live, owned=owned) == 0
        else:
            with pytest.raises(failure) as caught:
                room_tone.schedule_room_tone_pools(live, owned=owned)
            assert caught.value is error

    _assert_preparation_can_retry(live, foreign)


def test_interrupted_preparation_preserves_an_already_pending_requested_track(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    pending = room_tone._pool_key(live, "host")
    assert pending is not None
    room_tone._PENDING_POOLS.add(pending)

    def fail_snapshot(*args, **kwargs):
        raise KeyboardInterrupt("snapshot interrupted")

    with monkeypatch.context() as fault:
        fault.setattr(EpisodeProject, "model_copy", fail_snapshot)
        with pytest.raises(KeyboardInterrupt):
            room_tone.schedule_room_tone_pools(live)

    _assert_preparation_can_retry(live, pending, ("guest",))
    assert room_tone.read_room_tone_pool(live, "host") is None


@pytest.mark.parametrize("failure", [KeyboardInterrupt, SystemExit])
@pytest.mark.parametrize("point", ["pending", "registered"])
def test_interrupted_pool_claim_releases_only_its_claims_and_can_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: type[BaseException], point: str
) -> None:
    live = _two_speakers(tmp_path / "live")
    error = failure("claim interrupted")

    class InterruptedPending(set):
        interrupt = False

        def add(self, key):
            super().add(key)
            if self.interrupt:
                self.interrupt = False
                raise error

    real_claim = room_tone._claim_pool

    def fail_registered(*args, **kwargs):
        real_claim(*args, **kwargs)
        raise error

    if point == "pending":
        pending = InterruptedPending()
        monkeypatch.setattr(room_tone, "_PENDING_POOLS", pending)
    foreign = _foreign_pending(tmp_path)
    if point == "pending":
        pending.interrupt = True
    with monkeypatch.context() as fault:
        if point == "registered":
            fault.setattr(room_tone, "_claim_pool", fail_registered)
        with pytest.raises(failure) as caught:
            room_tone.schedule_room_tone_pools(live)
        assert caught.value is error
    _assert_preparation_can_retry(live, foreign)


@pytest.mark.parametrize("failure", [KeyboardInterrupt, RuntimeError])
def test_failed_pool_thread_construction_releases_claims_and_can_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: type[BaseException]
) -> None:
    live = _two_speakers(tmp_path / "live")
    foreign = _foreign_pending(tmp_path)
    error = failure("thread construction failed")

    def fail_thread(*args, **kwargs):
        raise error

    with monkeypatch.context() as fault:
        fault.setattr(room_tone.threading, "Thread", fail_thread)
        if isinstance(error, Exception):
            assert room_tone.schedule_room_tone_pools(live) == 0
        else:
            with pytest.raises(failure) as caught:
                room_tone.schedule_room_tone_pools(live)
            assert caught.value is error

    _assert_preparation_can_retry(live, foreign)


def test_interrupted_project_lock_release_releases_pool_claims_and_can_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path / "live")
    foreign = _foreign_pending(tmp_path)
    lock = project_state_lock(live)
    error = KeyboardInterrupt("lock release interrupted")

    class InterruptedRelease:
        def acquire(self, **kwargs):
            return lock.acquire(**kwargs)

        def release(self):
            lock.release()
            raise error

    with monkeypatch.context() as fault:
        fault.setattr(room_tone, "project_state_lock", lambda project: InterruptedRelease())
        with pytest.raises(KeyboardInterrupt) as caught:
            room_tone.schedule_room_tone_pools(live)
        assert caught.value is error

    _assert_preparation_can_retry(live, foreign)


def test_a_track_that_cannot_be_recorded_is_not_retried_until_the_memo_expires(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    monkeypatch.setattr(room_tone, "_voice_detector_missing", lambda: True)

    assert room_tone.schedule_room_tone_pools(live) == 2
    _join_pools()
    assert room_tone.read_room_tone_pool(live, "host") is None
    assert room_tone.schedule_room_tone_pools(live) == 0

    monkeypatch.setattr(room_tone, "UNRECORDED_RETRY_SEC", 0.0)
    assert room_tone.schedule_room_tone_pools(live) == 2
    _join_pools()


def test_recording_a_pool_that_is_pending_waits_for_it_instead_of_recording_twice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    live = _two_speakers(tmp_path)
    block = _Block(monkeypatch)
    assert room_tone.schedule_room_tone_pool(live, "host") is True
    assert block.started.wait(30)
    got: list[object] = []
    caller = threading.Thread(
        target=lambda: got.append(room_tone.record_room_tone_pool(live, "host")), name="caller"
    )
    caller.start()
    caller.join(0.5)
    assert caller.is_alive(), "the caller recorded its own copy instead of waiting"

    block.release.set()
    caller.join(60)
    _join_pools()

    assert got and got[0]
    assert block.recordings == 1
    assert room_tone.ensure_room_tone_pools(live, ["host"]) is None
    assert block.recordings == 1
