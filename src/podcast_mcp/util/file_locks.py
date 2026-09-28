"""One shared, re-entrant FileLock per sidecar lock path in this process."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from filelock import FileLock

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
