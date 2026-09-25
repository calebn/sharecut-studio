"""One shared, re-entrant FileLock per sidecar lock path in this process."""

from __future__ import annotations

import threading
from pathlib import Path

from filelock import FileLock

_LOCKS: dict[Path, FileLock] = {}
_GUARD = threading.Lock()


def shared_file_lock(lock_path: Path, *, timeout: float) -> FileLock:
    """Return this process's single ``FileLock`` for ``lock_path``, creating it on first use.

    Re-entrancy relies on every caller sharing this instance and on filelock's per-thread
    counter, so ``thread_local=True`` is passed explicitly. ``timeout`` is the default for
    the first caller; callers may pass their own to ``acquire``. Instances are never
    evicted (a holder may still be inside one); the registry is bounded by the lock paths
    this process touched. The parent directory is created outside the registry guard.
    """
    path = lock_path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    with _GUARD:
        lock = _LOCKS.get(path)
    if lock is not None:
        return lock
    candidate = FileLock(str(path), timeout=timeout, thread_local=True)
    with _GUARD:
        return _LOCKS.setdefault(path, candidate)
