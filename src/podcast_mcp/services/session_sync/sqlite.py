"""Shared SQLite connection setup for the session database."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

_WAL_INIT_LOCK = threading.Lock()


def connect_session_db(db_path: Path) -> sqlite3.Connection:
    """Open a session database after atomically establishing WAL mode.

    Record stores share ``sync.db`` but are constructed independently. SQLite
    persists the journal mode on the database, so only the first connection
    needs to change it. Serializing that one-time transition prevents parallel
    store constructors from racing on ``PRAGMA journal_mode=WAL``.
    """
    connection = sqlite3.connect(
        str(db_path),
        check_same_thread=False,
        isolation_level=None,
    )
    connection.row_factory = sqlite3.Row
    try:
        with _WAL_INIT_LOCK:
            journal_mode = str(connection.execute("PRAGMA journal_mode").fetchone()[0]).lower()
            if journal_mode != "wal":
                connection.execute("PRAGMA journal_mode=WAL")
    except Exception:
        connection.close()
        raise
    return connection
