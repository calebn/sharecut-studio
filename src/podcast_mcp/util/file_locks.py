"""One shared, re-entrant FileLock per sidecar lock path in this process."""

from __future__ import annotations

import os
import re
import stat
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from pathlib import Path

from filelock import FileLock, Timeout

if os.name == "posix":
    import fcntl

_LOCKS: dict[Path, FileLock] = {}
_GUARD = threading.Lock()


def shared_file_lock(lock_path: Path) -> FileLock:
    """Return this process's single ``FileLock`` for ``lock_path``, creating it on first use.

    Re-entrancy relies on every caller sharing this instance and on filelock's per-thread
    counter, so ``thread_local=True`` is passed explicitly. The registry builds each
    instance with ``timeout=0``, so a bare ``with lock:`` or ``lock.acquire()`` that forgets
    a timeout fails fast with ``filelock.Timeout`` instead of blocking forever (filelock's
    own default is ``-1``, wait forever). A caller that wants to wait longer than that must
    pass its own ``timeout`` to ``acquire`` (or use ``hold_shared_file_lock`` below); a
    thread that already holds the lock still re-enters at once no matter what timeout is in
    play. Instances are never evicted (a holder may still be inside one); the registry is
    bounded by the lock paths this process touched. The parent directory is created outside
    the registry guard.
    """
    path = lock_path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    with _GUARD:
        lock = _LOCKS.get(path)
    if lock is not None:
        return lock
    candidate = FileLock(str(path), timeout=0, thread_local=True)
    with _GUARD:
        return _LOCKS.setdefault(path, candidate)


@contextmanager
def hold_shared_file_lock(lock_path: Path, *, timeout: float) -> Iterator[FileLock]:
    """Acquire ``shared_file_lock(lock_path)`` with this caller's own ``timeout``.

    Use this instead of a bare ``with shared_file_lock(lock_path):`` whenever the caller
    needs to wait: the shared instance's own default is ``timeout=0`` (fail fast), so a bare
    acquire never waits for another holder. Raises ``filelock.Timeout`` if ``timeout``
    elapses first; re-entrant like the underlying instance.
    """
    lock = shared_file_lock(lock_path)
    with lock.acquire(timeout=timeout):
        yield lock


def unlink_if_unheld(lock_path: Path) -> None:
    """Best-effort delete of a lock file that no holder, in this or another process, has open.

    Skipped while anyone holds the lock, and on platforms that refuse to unlink an open file.
    The probe is its own instance (not the shared one), so it opens its own OS lock.
    """
    probe = FileLock(str(lock_path), thread_local=False)
    try:
        probe.acquire(timeout=0)
    except Timeout:
        return
    try:
        with suppress(OSError):
            lock_path.unlink()
    finally:
        probe.release()


def flock_exclusive_nonblocking(fd: int) -> None:
    """Take an exclusive ``flock`` on ``fd``; raises ``BlockingIOError`` if another holder has it.

    The lock lasts until ``fd`` is closed. POSIX only.
    """
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


@contextmanager
def try_hold_flock(lock_path: Path) -> Iterator[bool]:
    """Hold an exclusive ``flock`` on ``lock_path`` for the block; yields ``False`` if it is taken.

    No waiting and no per-process registry: a second caller in the same process also gets
    ``False`` because each call opens its own descriptor. POSIX only.
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+b") as handle:
        try:
            flock_exclusive_nonblocking(handle.fileno())
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


_PROC_LOCKS_MAX_BYTES = 1024 * 1024
_FLOCK_ROW = re.compile(
    r"\d+: FLOCK (ADVISORY|MANDATORY) (READ|WRITE) (-?\d+) "
    r"([0-9a-fA-F]+):([0-9a-fA-F]+):(\d+) (\d+) (EOF|\d+)"
)


def _flock_owner_pid(snapshot: str, identity: tuple[int, int]) -> int | None:
    owners: list[int] = []
    for line in snapshot.splitlines():
        fields = line.split()
        if "->" in fields or "FLOCK" not in fields:
            continue
        match = _FLOCK_ROW.fullmatch(" ".join(fields))
        if match is None:
            return None
        advisory, mode, pid, major, minor, inode, start, end = match.groups()
        if (os.makedev(int(major, 16), int(minor, 16)), int(inode)) != identity:
            continue
        if advisory == "ADVISORY" and mode == "WRITE" and start == "0" and end == "EOF":
            if int(pid) <= 0:
                return None
            owners.append(int(pid))
    return owners[0] if len(owners) == 1 else None


def file_lock_holder_pid(lock_path: Path) -> int | None:
    """Observe a granted whole-file Linux flock owner, or return unavailable."""
    if sys.platform != "linux":
        return None
    try:
        before = lock_path.lstat()
        if not stat.S_ISREG(before.st_mode):
            return None
        identity = before.st_dev, before.st_ino
        with Path("/proc/locks").open("rb") as source:
            data = source.read(_PROC_LOCKS_MAX_BYTES + 1)
        if len(data) > _PROC_LOCKS_MAX_BYTES:
            return None
        after = lock_path.lstat()
        if not stat.S_ISREG(after.st_mode) or (after.st_dev, after.st_ino) != identity:
            return None
        return _flock_owner_pid(data.decode("ascii"), identity)
    except (OSError, ValueError, OverflowError):
        return None
