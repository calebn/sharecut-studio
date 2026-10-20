"""A process-wide LRU map with a hard entry bound, its own lock, and a reset.

Module-level caches that outlive one call (an admitted binary pair, a parsed
file, a probe answer) use this instead of a bare ``dict``: the bound keeps a
long-running host from growing with every key it has ever seen, the lock makes
each operation atomic, and ``clear`` is what ``tests/process_caches.py`` calls
to isolate tests. A hit moves the entry to the most-recently-used end.

Callers that must compute a value exactly once per key (single flight) hold
``cache.lock`` across the get, the compute and the put. It is reentrant.
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from collections.abc import Iterator
from typing import Generic, TypeVar

K = TypeVar("K")
V = TypeVar("V")


class BoundedCache(Generic[K, V]):
    def __init__(self, maxsize: int) -> None:
        if maxsize < 1:
            raise ValueError("maxsize must be at least 1")
        self._maxsize = maxsize
        self._data: OrderedDict[K, V] = OrderedDict()
        self.lock = threading.RLock()

    @property
    def maxsize(self) -> int:
        return self._maxsize

    def get(self, key: K) -> V | None:
        """The cached value (now most recently used), or ``None`` on a miss."""
        with self.lock:
            value = self._data.get(key)
            if value is not None:
                self._data.move_to_end(key)
            return value

    def put(self, key: K, value: V) -> None:
        """Store *value*, evicting the least recently used entries past the bound."""
        with self.lock:
            self._data[key] = value
            self._data.move_to_end(key)
            while len(self._data) > self._maxsize:
                self._data.popitem(last=False)

    def pop(self, key: K) -> V | None:
        with self.lock:
            return self._data.pop(key, None)

    def clear(self) -> None:
        with self.lock:
            self._data.clear()

    def __iter__(self) -> Iterator[K]:
        """The keys, least recently used first, as a snapshot."""
        with self.lock:
            return iter(list(self._data))

    def __len__(self) -> int:
        with self.lock:
            return len(self._data)

    def __contains__(self, key: object) -> bool:
        with self.lock:
            return key in self._data
