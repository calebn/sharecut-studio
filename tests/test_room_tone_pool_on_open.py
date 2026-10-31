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


def _on_pool_thread() -> bool:
    return threading.current_thread().name.startswith("room-tone-pool-")


class _Block:
    """Holds the pool thread at the start of its recording until released."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.started, self.release = threading.Event(), threading.Event()
        self.projects: list[EpisodeProject] = []
        self.recordings = 0
        real = room_tone._no_foreign_voice

        def gate(project: EpisodeProject, track_id: str):
            if _on_pool_thread():
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
