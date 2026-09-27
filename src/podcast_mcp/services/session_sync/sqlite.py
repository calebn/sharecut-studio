"""Shared SQLite connection setup for the session database."""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path

from podcast_mcp.util.keyed_lock import KeyedLocks
from podcast_mcp.util.sqlite_tx import DEFAULT_BUSY_TIMEOUT_PRAGMA, is_sqlite_busy

_WAL_INIT_LOCKS: KeyedLocks[str, threading.Lock] = KeyedLocks(threading.Lock)
_WAL_INIT_TIMEOUT_SEC = 10.0
_WAL_INIT_RETRY_SEC = 0.05
# The WAL switch runs with the busy handler off (timeout=0) so the retry loop alone
# enforces _WAL_INIT_TIMEOUT_SEC; connect_session_db then restores
# DEFAULT_BUSY_TIMEOUT_PRAGMA for the store's later writes.


def _wal_init_key(db_path: Path) -> str:
    return str(db_path.resolve())


def _wal_init_lock(db_path: Path) -> threading.Lock:
    """Return the in-process lock that serializes the WAL switch for *db_path*.

    Keyed by resolved path so a retry on one busy database never blocks
    connections to another session database in this process.
    """
    return _WAL_INIT_LOCKS.get(_wal_init_key(db_path))


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


def connect_session_db(db_path: Path, *, create: bool = True) -> sqlite3.Connection:
    """Open a session database after atomically establishing WAL mode.

    Record stores share ``sync.db`` but are constructed independently. SQLite
    persists the journal mode on the database, so only the first connection
    needs to change it. A per-database thread lock (keyed by resolved path)
    serializes that one-time transition inside this process, so a retry on
    one busy database never blocks another. The lock is dropped once the
    switch succeeds, since later opens only read the persisted mode. Another
    process can still hold the database lock, and SQLite may return busy for
    a journal-mode change without invoking the busy handler, so the
    read-and-switch runs with the busy handler off (``timeout=0``) and is
    retried every ``_WAL_INIT_RETRY_SEC`` for up to
    ``_WAL_INIT_TIMEOUT_SEC``; the connection then gets SQLite's default 5 s
    busy timeout back for its writes.

    With ``create=False`` the file is opened with sqlite's ``mode=rw`` URI, so a
    missing file raises ``sqlite3.OperationalError`` instead of being created.
    The read-only meta polls rely on this to never recreate a store that
    another process deleted.
    """
    target = str(db_path) if create else f"{db_path.resolve().as_uri()}?mode=rw"
    connection = sqlite3.connect(
        target,
        check_same_thread=False,
        isolation_level=None,
        timeout=0,
        uri=not create,
    )
    connection.row_factory = sqlite3.Row
    try:
        with _wal_init_lock(db_path):
            _ensure_wal(connection)
        # WAL now persists on the file, so later opens only read journal_mode; drop
        # the lock so the registry does not grow with every sync.db this process opens.
        _WAL_INIT_LOCKS.discard_idle(_wal_init_key(db_path))
        connection.execute(DEFAULT_BUSY_TIMEOUT_PRAGMA)
    except Exception:
        connection.close()
        raise
    return connection
