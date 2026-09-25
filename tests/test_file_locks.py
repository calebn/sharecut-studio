"""Shared per-path FileLock registry."""

from __future__ import annotations

from pathlib import Path

from podcast_mcp.util.file_locks import shared_file_lock


def test_shared_file_lock_is_one_reentrant_instance_per_path(tmp_path: Path) -> None:
    lock_path = tmp_path / "artifacts" / "x.lock"
    lock = shared_file_lock(lock_path, timeout=1.0)
    assert lock_path.parent.is_dir()
    same = shared_file_lock(tmp_path / "artifacts" / ".." / "artifacts" / "x.lock", timeout=5.0)
    assert lock is same
    assert lock.is_thread_local
    assert lock.timeout == 1.0
    with lock, lock:
        assert lock.is_locked
    assert not lock.is_locked


def test_shared_file_lock_differs_per_path(tmp_path: Path) -> None:
    assert shared_file_lock(tmp_path / "a.lock", timeout=1.0) is not shared_file_lock(
        tmp_path / "b.lock", timeout=1.0
    )
