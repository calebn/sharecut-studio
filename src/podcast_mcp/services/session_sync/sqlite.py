"""Shared SQLite connection setup for the session database."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from podcast_mcp.util.keyed_lock import KeyedLocks
from podcast_mcp.util.sqlite_open import open_sqlite, schema_setup

_WAL_INIT_LOCKS: KeyedLocks[str, threading.Lock] = KeyedLocks(threading.Lock)
_WAL_INIT_PENDING_GUARD = threading.Lock()
_WAL_INIT_PENDING: dict[str, int] = {}
_WAL_INIT_TIMEOUT_SEC = 10.0
_WAL_INIT_RETRY_SEC = 0.05


def _wal_init_key(db_path: Path) -> str:
    return str(db_path.resolve())


def _wal_init_lock(db_path: Path) -> threading.Lock:
    """Return the in-process lock that serializes the WAL switch for *db_path*.

    Keyed by resolved path so a retry on one busy database never blocks
    connections to another session database in this process.
    """
    return _WAL_INIT_LOCKS.get(_wal_init_key(db_path))


def _with_empty_uri_authority(uri: str) -> str:
    """Move a UNC server out of a ``file:`` URI's authority and into its path.

    ``Path.as_uri()`` on a Windows UNC path gives ``file://server/share/...``. SQLite
    rejects any authority other than empty or ``localhost`` ("invalid uri authority")
    unless built with ``SQLITE_ALLOW_URI_AUTHORITY``, and CPython's bundled SQLite is
    not. ``file:////server/share/...`` has an empty authority, and SQLite on Windows
    opens its path as ``\\\\server\\share\\...``. Local paths (``file:///...``) are unchanged.
    """
    prefix = "file://"
    if uri.startswith(prefix) and not uri.startswith("file:///"):
        return "file:////" + uri[len(prefix) :]
    return uri


def connect_session_db(
    db_path: Path,
    *,
    create: bool = True,
    schema: str | None = None,
) -> sqlite3.Connection:
    """Open a session database after atomically establishing WAL mode.

    Record stores share ``sync.db`` but are constructed independently. SQLite
    persists the journal mode on the database, so only the first connection
    needs to change it. A per-database thread lock (keyed by resolved path)
    serializes that one-time transition inside this process, so a retry on
    one busy database never blocks another. The lock is dropped once the
    switch succeeds, or when a failed attempt leaves no other thread waiting
    on it, since later opens only read the persisted mode. Another
    process can still hold the database lock, and SQLite may return busy for
    a journal-mode change without invoking the busy handler, so the
    read-and-switch runs with the busy handler off (``timeout=0``) and is
    retried every ``_WAL_INIT_RETRY_SEC`` for up to
    ``_WAL_INIT_TIMEOUT_SEC``; the connection then gets SQLite's default 5 s
    busy timeout back for its writes.

    A store passes its idempotent *schema* so it is applied inside the same bounded
    retry as the switch (a concurrent first open can answer readonly to either, #1932).

    With ``create=False`` the file is opened with sqlite's ``mode=rw`` URI, so a
    missing file raises ``sqlite3.OperationalError`` instead of being created.
    The read-only meta polls rely on this to never recreate a store that
    another process deleted. The URI always has an empty authority
    (``_with_empty_uri_authority``), so a workspace on a Windows UNC share opens too.
    """
    target = (
        str(db_path)
        if create
        else f"{_with_empty_uri_authority(db_path.resolve().as_uri())}?mode=rw"
    )
    key = _wal_init_key(db_path)
    with _WAL_INIT_PENDING_GUARD:
        _WAL_INIT_PENDING[key] = _WAL_INIT_PENDING.get(key, 0) + 1
        lock = _WAL_INIT_LOCKS.get(key)
    connected = False
    try:
        with lock:
            connection = open_sqlite(
                target,
                uri=not create,
                row_factory=sqlite3.Row,
                wal_timeout_sec=_WAL_INIT_TIMEOUT_SEC,
                wal_retry_sec=_WAL_INIT_RETRY_SEC,
                setup=None if schema is None else schema_setup(schema),
            )
            connected = True
    finally:
        # Drop the lock so the registry does not grow with every sync.db this process
        # opens, or keeps failing to open (a deleted or locked one the meta polls keep
        # hitting). After a failure the switch is still owed, so keep the lock while
        # another thread waits on it; WAL persists on the file after a success.
        with _WAL_INIT_PENDING_GUARD:
            remaining = _WAL_INIT_PENDING[key] - 1
            if remaining:
                _WAL_INIT_PENDING[key] = remaining
            else:
                del _WAL_INIT_PENDING[key]
            if connected or not remaining:
                _WAL_INIT_LOCKS.discard_idle(key)
    return connection
