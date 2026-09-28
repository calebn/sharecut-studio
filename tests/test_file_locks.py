"""Shared per-path FileLock registry."""

from __future__ import annotations

import inspect
import threading
from pathlib import Path

from filelock import Timeout

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
