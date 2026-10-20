"""Journal mode, busy timeout and isolation of every sqlite store's connection."""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

from podcast_mcp.edits.share_registry import SqliteShareRegistry
from podcast_mcp.services.session_sync.sqlite import connect_session_db
from podcast_mcp.services.share_auth.store import ShareIdentityStore
from podcast_relay import reports


def _pragma(connection: sqlite3.Connection, name: str) -> object:
    return connection.execute(f"PRAGMA {name}").fetchone()[0]


def test_session_sync_store_is_wal_with_the_default_busy_timeout(tmp_path: Path) -> None:
    with closing(connect_session_db(tmp_path / "sync.db")) as connection:
        assert _pragma(connection, "journal_mode") == "wal"
        assert _pragma(connection, "busy_timeout") == 5000
        assert connection.isolation_level is None
        assert connection.row_factory is sqlite3.Row


def test_share_identity_store_is_wal_with_the_default_busy_timeout(tmp_path: Path) -> None:
    store = ShareIdentityStore(tmp_path / "identity.sqlite")
    try:
        assert _pragma(store._conn, "journal_mode") == "wal"
        assert _pragma(store._conn, "busy_timeout") == 5000
        assert store._conn.isolation_level == ""
        assert store._conn.row_factory is sqlite3.Row
    finally:
        store.close()


def test_share_registry_is_wal_normal_sync_with_the_default_busy_timeout(tmp_path: Path) -> None:
    with closing(SqliteShareRegistry(tmp_path / "registry.db")) as registry:
        connection = registry._conn
        assert _pragma(connection, "journal_mode") == "wal"
        assert _pragma(connection, "busy_timeout") == 5000
        assert _pragma(connection, "synchronous") == 1
        assert connection.isolation_level is None


def test_relay_reports_keep_the_rollback_journal_with_a_ten_second_busy_timeout(
    tmp_path: Path,
) -> None:
    with reports._db(tmp_path) as db:
        assert _pragma(db, "journal_mode") == "delete"
        assert _pragma(db, "busy_timeout") == 10000
        assert db.isolation_level is None
