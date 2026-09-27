"""Shared SQLite connection setup for the session database."""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

from podcast_mcp.util.sqlite_tx import is_sqlite_busy

_WAL_INIT_LOCK = threading.Lock()
_WAL_INIT_TIMEOUT_SEC = 10.0
_WAL_INIT_RETRY_SEC = 0.05


def _ensure_wal(connection: sqlite3.Connection) -> None:
    """Switch *connection*'s database to WAL, retrying while another process holds the lock."""
    deadline = time.monotonic() + _WAL_INIT_TIMEOUT_SEC
    while True:
        try:
            journal_mode = str(connection.execute("PRAGMA journal_mode").fetchone()[0]).lower()
            if journal_mode != "wal":
                connection.execute("PRAGMA journal_mode=WAL")
            return
        except sqlite3.OperationalError as exc:
            if not is_sqlite_busy(exc) or time.monotonic() >= deadline:
                raise
            time.sleep(_WAL_INIT_RETRY_SEC)


def connect_session_db(db_path: Path) -> sqlite3.Connection:
    """Open a session database after atomically establishing WAL mode.

    Record stores share ``sync.db`` but are constructed independently. SQLite
    persists the journal mode on the database, so only the first connection
    needs to change it. A thread lock serializes that one-time transition
    inside this process. Another process can still hold the database lock,
    and SQLite may return busy for a journal-mode change without invoking the
    busy handler, so the read-and-switch is retried for up to
    ``_WAL_INIT_TIMEOUT_SEC``.
    """
    connection = sqlite3.connect(
        str(db_path),
        check_same_thread=False,
        isolation_level=None,
    )
    connection.row_factory = sqlite3.Row
    try:
        with _WAL_INIT_LOCK:
            _ensure_wal(connection)
    except Exception:
        connection.close()
        raise
    return connection
