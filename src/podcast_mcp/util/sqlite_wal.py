from __future__ import annotations

import sqlite3
import time
from collections.abc import Callable

from podcast_mcp.util.sqlite_tx import is_sqlite_busy


def ensure_wal(
    connection: sqlite3.Connection,
    *,
    timeout_sec: float = 10.0,
    retry_sec: float = 0.05,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Switch *connection*'s database to WAL, retrying while another process holds the lock."""
    deadline = monotonic() + timeout_sec
    while True:
        try:
            journal_mode = str(connection.execute("PRAGMA journal_mode").fetchone()[0]).lower()
            if journal_mode != "wal":
                connection.execute("PRAGMA journal_mode=WAL")
            return
        except sqlite3.OperationalError as exc:
            if not is_sqlite_busy(exc) or monotonic() >= deadline:
                raise
            sleep(retry_sec)
