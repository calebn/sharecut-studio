"""Shared SQLite connection setup for the session database."""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

from podcast_mcp.util.sqlite_tx import is_sqlite_busy

_WAL_INIT_LOCKS: dict[str, threading.Lock] = {}
_WAL_INIT_LOCKS_GUARD = threading.Lock()
_WAL_INIT_TIMEOUT_SEC = 10.0
_WAL_INIT_RETRY_SEC = 0.05
# sqlite3.connect's default busy timeout (5 s). The WAL switch runs with the busy
# handler off (timeout=0) so the retry loop alone enforces _WAL_INIT_TIMEOUT_SEC;
# this restores the default for the store's later writes.
_BUSY_TIMEOUT_PRAGMA = "PRAGMA busy_timeout=5000"


def _wal_init_lock(db_path: Path) -> threading.Lock:
    """Return the in-process lock that serializes the WAL switch for *db_path*.

    Keyed by resolved path so a retry on one busy database never blocks
    connections to another session database in this process.
    """
    key = str(db_path.resolve())
    with _WAL_INIT_LOCKS_GUARD:
        return _WAL_INIT_LOCKS.setdefault(key, threading.Lock())


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
    needs to change it. A per-database thread lock (keyed by resolved path)
    serializes that one-time transition inside this process, so a retry on
    one busy database never blocks another. Another process can still hold
    the database lock, and SQLite may return busy for a journal-mode change
    without invoking the busy handler, so the read-and-switch runs with the
    busy handler off (``timeout=0``) and is retried every
    ``_WAL_INIT_RETRY_SEC`` for up to ``_WAL_INIT_TIMEOUT_SEC``; the
    connection then gets SQLite's default 5 s busy timeout back for its
    writes.
    """
    connection = sqlite3.connect(
        str(db_path),
        check_same_thread=False,
        isolation_level=None,
        timeout=0,
    )
    connection.row_factory = sqlite3.Row
    try:
        with _wal_init_lock(db_path):
            _ensure_wal(connection)
        connection.execute(_BUSY_TIMEOUT_PRAGMA)
    except Exception:
        connection.close()
        raise
    return connection
