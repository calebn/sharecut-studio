"""One in-process lock per key: the guard, dict and get-or-create idiom in one place."""

from __future__ import annotations

import threading
from collections.abc import Callable, Hashable
from typing import Generic, Protocol, TypeVar


class _Lock(Protocol):
    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool: ...

    def release(self) -> None: ...


_K = TypeVar("_K", bound=Hashable)
_L = TypeVar("_L", bound=_Lock)


class KeyedLocks(Generic[_K, _L]):
    """Thread-safe registry holding one lock per key, created by *factory* on first use.

    Entries live until ``discard_idle`` drops them. Use it for any new in-process
    keyed lock instead of a private guard + dict pair.
    """

    def __init__(self, factory: Callable[[], _L]) -> None:
        self._factory = factory
        self._guard = threading.Lock()
        self._locks: dict[_K, _L] = {}

    def get(self, key: _K) -> _L:
        """Return the lock for *key*, creating it on first use."""
        with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = self._factory()
                self._locks[key] = lock
            return lock

    def discard_idle(self, key: _K) -> None:
        """Drop *key*'s lock unless a thread holds it; a missing key is a no-op.

        A thread that already fetched the lock but has not acquired it yet keeps its
        (now unregistered) instance, so only discard once the guarded work no longer
        needs mutual exclusion or the key is finished. For a re-entrant lock, the
        owning thread counts as idle.
        """
        with self._guard:
            lock = self._locks.get(key)
            if lock is None or not lock.acquire(blocking=False):
                return
            try:
                del self._locks[key]
            finally:
                lock.release()

    def __contains__(self, key: object) -> bool:
        with self._guard:
            return key in self._locks
