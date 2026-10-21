"""Every sqlite store opens through ``open_sqlite``: WAL, a busy timeout, and no surprises."""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from podcast_mcp.config.defaults import repo_root
from podcast_mcp.services.collaboration.share_registry import SqliteShareRegistry
from podcast_mcp.services.session_sync.sqlite import connect_session_db
from podcast_mcp.services.share_auth.store import ShareIdentityStore
from podcast_mcp.util.sqlite_open import open_sqlite
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
        assert store._conn.isolation_level == "DEFERRED"
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


def test_relay_reports_are_wal_with_a_ten_second_busy_timeout(tmp_path: Path) -> None:
    with reports._db(tmp_path) as db:
        assert _pragma(db, "journal_mode") == "wal"
        assert _pragma(db, "busy_timeout") == 10000
        assert db.isolation_level is None


def test_open_sqlite_defaults_and_closes_the_connection_when_a_check_fails(
    tmp_path: Path,
) -> None:
    path = tmp_path / "plain.db"
    with closing(open_sqlite(path)) as connection:
        assert _pragma(connection, "journal_mode") == "wal"
        assert _pragma(connection, "busy_timeout") == 5000

    seen: list[sqlite3.Connection] = []

    class Refused(Exception):
        pass

    def refuse() -> None:
        raise Refused

    original = sqlite3.connect

    def spy(*args: object, **kwargs: object) -> sqlite3.Connection:
        connection = original(*args, **kwargs)  # type: ignore[call-overload]
        seen.append(connection)
        return connection

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(sqlite3, "connect", spy)
        with pytest.raises(Refused):
            open_sqlite(path, verify=refuse)
    with pytest.raises(sqlite3.ProgrammingError):
        seen[0].execute("select 1")


def test_open_sqlite_runs_verify_after_connect_and_after_the_wal_switch(tmp_path: Path) -> None:
    modes: list[object] = []
    path = tmp_path / "verify.db"

    def verify() -> None:
        with closing(sqlite3.connect(path)) as probe:
            modes.append(_pragma(probe, "journal_mode"))

    with closing(open_sqlite(path, verify=verify)):
        pass
    assert modes == ["delete", "wal"]


def test_only_the_opener_and_the_registry_backup_target_call_sqlite_connect() -> None:
    src = repo_root() / "src"
    callers = sorted(
        str(path.relative_to(src))
        for path in src.rglob("*.py")
        if "sqlite3.connect(" in path.read_text(encoding="utf-8")
    )
    assert callers == [
        "podcast_mcp/services/collaboration/share_registry.py",
        "podcast_mcp/util/sqlite_open.py",
    ]


def test_open_sqlite_retries_the_setup_with_the_wal_switch_on_a_transient_readonly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("time.sleep", lambda _seconds: None)
    attempts: list[int] = []

    def setup(connection: sqlite3.Connection) -> None:
        attempts.append(1)
        if len(attempts) <= 2:
            exc = sqlite3.OperationalError("attempt to write a readonly database")
            exc.sqlite_errorcode = sqlite3.SQLITE_READONLY  # type: ignore[attr-defined]
            raise exc
        connection.executescript("CREATE TABLE IF NOT EXISTS t (x)")

    with closing(open_sqlite(tmp_path / "s.db", setup=setup)) as connection:
        assert len(attempts) == 3
        assert connection.execute("SELECT count(*) FROM t").fetchone()[0] == 0
        assert _pragma(connection, "journal_mode") == "wal"


def test_open_sqlite_closes_the_connection_when_the_setup_fails(tmp_path: Path) -> None:
    opened: list[sqlite3.Connection] = []

    def setup(connection: sqlite3.Connection) -> None:
        opened.append(connection)
        raise sqlite3.OperationalError("disk I/O error")

    with pytest.raises(sqlite3.OperationalError, match="disk I/O"):
        open_sqlite(tmp_path / "s.db", setup=setup)
    with pytest.raises(sqlite3.ProgrammingError):
        opened[0].execute("SELECT 1")


def test_connect_session_db_applies_the_schema_it_is_given(tmp_path: Path) -> None:
    with closing(
        connect_session_db(tmp_path / "s.db", schema="CREATE TABLE IF NOT EXISTS t (x)")
    ) as c:
        assert c.execute("SELECT count(*) FROM t").fetchone()[0] == 0


def test_open_sqlite_verifies_the_sidecars_before_the_setup_writes(tmp_path: Path) -> None:
    events: list[str] = []
    path = tmp_path / "verify.db"

    def verify() -> None:
        events.append("verify")

    def setup(connection: sqlite3.Connection) -> None:
        events.append("setup")
        connection.executescript("CREATE TABLE IF NOT EXISTS t (x)")

    with closing(open_sqlite(path, verify=verify, setup=setup)):
        pass
    assert events == ["verify", "verify", "setup", "verify"]
