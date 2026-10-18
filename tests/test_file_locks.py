"""Shared per-path FileLock registry."""

from __future__ import annotations

import inspect
import io
import os
import threading
from pathlib import Path

import pytest
from filelock import Timeout

from podcast_mcp.util import file_locks
from podcast_mcp.util.file_locks import hold_shared_file_lock, shared_file_lock


def test_shared_file_lock_is_one_reentrant_instance_per_path(tmp_path: Path) -> None:
    lock_path = tmp_path / "artifacts" / "x.lock"
    lock = shared_file_lock(lock_path)
    assert lock_path.parent.is_dir()
    same = shared_file_lock(tmp_path / "artifacts" / ".." / "artifacts" / "x.lock")
    assert lock is same
    assert lock.is_thread_local()
    assert lock.timeout == 0
    with hold_shared_file_lock(lock_path, timeout=1.0), hold_shared_file_lock(lock_path, timeout=0):
        assert lock.is_locked
    assert not lock.is_locked


def test_shared_file_lock_differs_per_path(tmp_path: Path) -> None:
    assert shared_file_lock(tmp_path / "a.lock") is not shared_file_lock(tmp_path / "b.lock")


def test_shared_file_lock_takes_no_timeout() -> None:
    assert list(inspect.signature(shared_file_lock).parameters) == ["lock_path"]


def test_bare_acquire_never_blocks(tmp_path: Path) -> None:
    lock_path = tmp_path / "artifacts" / "x.lock"
    lock = shared_file_lock(lock_path)
    outcome: list[str] = []

    def worker() -> None:
        try:
            with shared_file_lock(lock_path):
                outcome.append("acquired")
        except Timeout:
            outcome.append("timeout")

    with lock:
        thread = threading.Thread(target=worker)
        thread.start()
        thread.join()
    assert outcome == ["timeout"]


def test_hold_shared_file_lock_releases_on_error(tmp_path: Path) -> None:
    lock_path = tmp_path / "artifacts" / "x.lock"
    lock = shared_file_lock(lock_path)

    class Boom(Exception):
        pass

    try:
        with hold_shared_file_lock(lock_path, timeout=1.0):
            raise Boom
    except Boom:
        pass
    assert not lock.is_locked


def test_each_acquisition_uses_its_own_timeout(tmp_path: Path) -> None:
    lock_path = tmp_path / "artifacts" / "x.lock"
    outcome: list[str] = []

    def fast_worker() -> None:
        try:
            with hold_shared_file_lock(lock_path, timeout=0.05):
                outcome.append("fast-acquired")
        except Timeout:
            outcome.append("fast-timeout")

    def slow_worker() -> None:
        with hold_shared_file_lock(lock_path, timeout=5.0):
            outcome.append("slow-acquired")

    with hold_shared_file_lock(lock_path, timeout=1.0):
        fast = threading.Thread(target=fast_worker)
        fast.start()
        fast.join()
        slow = threading.Thread(target=slow_worker)
        slow.start()
        # The main thread releases before the slow worker's 5 s timeout elapses.
    slow.join()
    assert outcome == ["fast-timeout", "slow-acquired"]


def test_shared_file_lock_blocks_other_threads(tmp_path: Path) -> None:
    lock_path = tmp_path / "artifacts" / "x.lock"
    lock = shared_file_lock(lock_path)
    outcome: list[str] = []

    def worker() -> None:
        try:
            with hold_shared_file_lock(lock_path, timeout=0.1):
                outcome.append("acquired")
        except Timeout:
            outcome.append("timeout")

    with hold_shared_file_lock(lock_path, timeout=1.0):
        thread = threading.Thread(target=worker)
        thread.start()
        thread.join()
    assert outcome == ["timeout"]
    thread = threading.Thread(target=worker)
    thread.start()
    thread.join()
    assert outcome == ["timeout", "acquired"]
    assert not lock.is_locked


@pytest.mark.skipif(not hasattr(os, "makedev"), reason="Linux kernel device identity")
@pytest.mark.parametrize(
    ("snapshot", "owner"),
    [
        ("1: FLOCK ADVISORY WRITE 42 08:01:123 0 EOF", 42),
        (
            "1: FLOCK ADVISORY READ 43 08:01:124 0 EOF\n"
            "2: FLOCK ADVISORY WRITE 44 08:01:125 1 10\n"
            "3: POSIX ADVISORY WRITE 45 08:01:126 0 EOF\n"
            "4: FLOCK ADVISORY WRITE 42 08:01:123 0 EOF",
            42,
        ),
        ("1: FLOCK ADVISORY WRITE 42 08:01:124 0 EOF", None),
        ("1: FLOCK ADVISORY WRITE 42 08:02:123 0 EOF", None),
        ("1: -> FLOCK ADVISORY WRITE 42 08:01:123 0 EOF", None),
        ("1: FLOCK ADVISORY READ 42 08:01:123 0 EOF", None),
        ("1: FLOCK ADVISORY WRITE 42 08:01:123 1 EOF", None),
        ("1: FLOCK ADVISORY WRITE -1 08:01:123 0 EOF", None),
        ("1: FLOCK ADVISORY WRITE broken", None),
        (
            "1: FLOCK ADVISORY WRITE 42 08:01:123 0 EOF\n"
            "2: FLOCK ADVISORY WRITE 43 08:01:123 0 EOF",
            None,
        ),
        (
            "1: FLOCK ADVISORY WRITE 42 08:01:123 0 EOF\n"
            "1: -> FLOCK ADVISORY WRITE 43 08:01:123 0 EOF",
            42,
        ),
    ],
)
def test_kernel_snapshot_only_identifies_one_granted_whole_file_owner(snapshot, owner):
    assert file_locks._flock_owner_pid(snapshot, (os.makedev(8, 1), 123)) == owner


@pytest.mark.skipif(not hasattr(os, "major"), reason="Linux kernel device identity")
@pytest.mark.parametrize("failure", ["inaccessible", "oversized", "malformed", "replaced"])
def test_holder_observation_fails_to_unknown(tmp_path, monkeypatch, failure):
    lock_path = tmp_path / "x.lock"
    lock_path.touch()
    stat = lock_path.stat()
    row = (
        f"1: FLOCK ADVISORY WRITE 42 "
        f"{os.major(stat.st_dev):x}:{os.minor(stat.st_dev):x}:{stat.st_ino} 0 EOF\n"
    ).encode()
    monkeypatch.setattr(file_locks.sys, "platform", "linux")

    def open_snapshot(self, mode):
        assert self == Path("/proc/locks")
        assert mode == "rb"
        if failure == "inaccessible":
            raise PermissionError("unavailable")
        if failure == "replaced":
            lock_path.rename(tmp_path / "previous.lock")
            lock_path.touch()
        if failure == "oversized":
            return io.BytesIO(b"x" * (file_locks._PROC_LOCKS_MAX_BYTES + 1))
        return io.BytesIO(b"\xff" if failure == "malformed" else row)

    monkeypatch.setattr(Path, "open", open_snapshot)
    assert file_locks.file_lock_holder_pid(lock_path) is None


@pytest.mark.parametrize("platform", ["darwin", "win32"])
def test_holder_observation_is_unavailable_off_linux(tmp_path, monkeypatch, platform):
    monkeypatch.setattr(file_locks.sys, "platform", platform)
    assert file_locks.file_lock_holder_pid(tmp_path / "absent.lock") is None


@pytest.mark.parametrize(
    "kind",
    [
        pytest.param(
            "symlink",
            marks=pytest.mark.skipif(os.name == "nt", reason="Windows symlink privileges"),
        ),
        "directory",
    ],
)
def test_holder_observation_requires_a_regular_lock_file(tmp_path, monkeypatch, kind):
    monkeypatch.setattr(file_locks.sys, "platform", "linux")
    lock_path = tmp_path / "x.lock"
    if kind == "symlink":
        target = tmp_path / "target.lock"
        target.touch()
        lock_path.symlink_to(target)
    else:
        lock_path.mkdir()
    assert file_locks.file_lock_holder_pid(lock_path) is None
