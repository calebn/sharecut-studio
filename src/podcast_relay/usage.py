"""Monthly byte counters for the relay's caps, in memory with an optional SQLite file.

The relay is one process, so the counters live in a dict and ``flush`` writes the ones that
changed. A file lets a restart keep the month. Without one (the default, and every test and
self-host relay that never sets ``PODCAST_RELAY_USAGE_DB``) a restart starts the month at zero.
A new UTC calendar month clears every counter.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from pathlib import Path

from podcast_mcp.util.sqlite_open import open_sqlite, schema_setup

_SCHEMA = """
CREATE TABLE IF NOT EXISTS usage (
    period TEXT NOT NULL,
    key TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    PRIMARY KEY (period, key)
);
"""


def current_period(now: float) -> str:
    return time.strftime("%Y-%m", time.gmtime(now))


class UsageLedger:
    def __init__(self, path: Path | None = None, *, clock: Callable[[], float] = time.time) -> None:
        self.clock = clock
        self._lock = threading.Lock()
        self._counts: dict[str, int] = {}
        self._dirty: set[str] = set()
        self._period = ""
        self._db = None
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._db = open_sqlite(path, setup=schema_setup(_SCHEMA))
        with self._lock:
            self._roll()

    def _roll(self) -> None:
        period = current_period(self.clock())
        if period == self._period:
            return
        self._period = period
        self._counts = {}
        self._dirty = set()
        if self._db is not None:
            self._db.execute("DELETE FROM usage WHERE period != ?", (period,))
            rows = self._db.execute("SELECT key, bytes FROM usage WHERE period = ?", (period,))
            self._counts = {str(key): int(total) for key, total in rows}

    def used(self, key: str) -> int:
        with self._lock:
            self._roll()
            return self._counts.get(key, 0)

    def add(self, key: str, nbytes: int) -> None:
        if nbytes <= 0:
            return
        with self._lock:
            self._roll()
            self._counts[key] = self._counts.get(key, 0) + nbytes
            self._dirty.add(key)

    def flush(self) -> None:
        """Write the changed counters. A failed write leaves them dirty for the next flush."""
        if self._db is None:
            return
        with self._lock:
            self._roll()
            rows = [(self._period, key, self._counts[key]) for key in self._dirty]
            if rows:
                self._db.executemany("INSERT OR REPLACE INTO usage VALUES (?, ?, ?)", rows)
            self._dirty = set()

    def close(self) -> None:
        try:
            self.flush()
        finally:
            if self._db is not None:
                self._db.close()
                self._db = None
