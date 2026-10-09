from __future__ import annotations

import multiprocessing
import sqlite3
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from podcast_mcp.edits.share_registry import SqliteShareRegistry
from podcast_mcp.services.session_sync import sqlite as session_sqlite
from test_share_registry import _share_template
from test_share_registry_recovery import ProbeConnection


@pytest.mark.parametrize("mutation", ["claim", "release", "demote"])
def test_failed_token_commit_and_rollback_quarantines_pending_state_and_recovers(
    tmp_path: Path, mutation: str
) -> None:
    path = tmp_path / "registry.db"
    registry = SqliteShareRegistry(path)
    try:
        secret = registry.recording_key_secret()
        registry.claim_active(_share_template(token="durable-token", id="durable-id"))
        poisoned = ProbeConnection(str(path), isolation_level=None)
        poisoned.row_factory = sqlite3.Row
        registry._conn.close()
        registry._conn = poisoned
        failure = sqlite3.OperationalError("commit failed")
        poisoned.failures["COMMIT"] = failure
        poisoned.failures["ROLLBACK"] = sqlite3.OperationalError("rollback failed")
        with pytest.raises(sqlite3.OperationalError) as caught:
            if mutation == "claim":
                registry.claim_active(_share_template(token="uncommitted-token", id="ghost-id"))
            elif mutation == "release":
                registry.release_claim("durable-token")
            else:
                registry.demote_to_cooldown("durable-token", reason="revoked")
        assert caught.value is failure
        with closing(sqlite3.connect(path)) as observer:
            assert observer.execute("SELECT token, id FROM active_shares").fetchall() == [
                ("durable-token", "durable-id")
            ]
            assert (
                observer.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
            )
        assert registry.get_active("uncommitted-token") is None
        durable_row = registry.get_active("durable-token")
        assert durable_row is not None and durable_row["id"] == "durable-id"
        assert registry.recording_key_secret() == secret
        registry.claim_active(_share_template(token="after-recovery", id="future-id"))
        with closing(sqlite3.connect(path)) as observer:
            assert observer.execute(
                "SELECT token, id FROM active_shares ORDER BY token"
            ).fetchall() == [("after-recovery", "future-id"), ("durable-token", "durable-id")]
        fresh = SqliteShareRegistry(path)
        try:
            assert fresh.recording_key_secret() == secret
            assert fresh.get_active("after-recovery")["id"] == "future-id"
        finally:
            fresh.close()
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            poisoned.execute("SELECT 1")
    finally:
        registry.close()


def _migration_actor(path: str, barrier: Any, queue: Any) -> None:
    connect = sqlite3.connect

    class UncommittedSchemaProbeRows:
        def __init__(self, rows: list[sqlite3.Row]) -> None:
            self.rows = rows

        def __iter__(self) -> Iterator[sqlite3.Row]:
            return iter(self.rows)

    class UncommittedSchemaProbeConnection(sqlite3.Connection):
        def execute(self, sql: str, *args: Any, **kwargs: Any) -> Any:
            result = super().execute(sql, *args, **kwargs)
            is_schema_probe = sql == "PRAGMA table_info(active_shares)"
            if is_schema_probe and not self.in_transaction:
                rows = result.fetchall()
                barrier.wait(timeout=15)
                return UncommittedSchemaProbeRows(rows)
            return result

    def open_connection(*args: Any, **kwargs: Any) -> sqlite3.Connection:
        return connect(*args, **kwargs, factory=UncommittedSchemaProbeConnection)

    registry = None
    try:
        with patch("podcast_mcp.edits.share_registry.sqlite3.connect", open_connection):
            registry = SqliteShareRegistry(Path(path))
        queue.put(("ok", registry.get_active("legacy-token"), registry.recording_key_secret()))
    except BaseException as exc:
        queue.put(("error", type(exc).__name__, str(exc)))
    finally:
        if registry:
            registry.close()


def test_concurrent_legacy_registry_migration_preserves_tokens_and_secret(tmp_path: Path) -> None:
    path = tmp_path / "legacy.db"
    secret = b"l" * 32
    with closing(sqlite3.connect(path, isolation_level=None)) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("""CREATE TABLE active_shares (
            token TEXT PRIMARY KEY, project_workspace TEXT NOT NULL,
            review_version_id TEXT NOT NULL, created_at TEXT NOT NULL,
            last_used_at TEXT NOT NULL, expires_at TEXT, capabilities TEXT NOT NULL
        )""")
        connection.execute(
            "INSERT INTO active_shares VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                "legacy-token",
                "/legacy/workspace",
                "v1",
                "2026-10-09T00:00:00+00:00",
                "2026-10-09T00:00:00+00:00",
                None,
                '["play"]',
            ),
        )
        connection.execute(
            "CREATE TABLE recording_key_secret (singleton INTEGER PRIMARY KEY, secret BLOB NOT NULL)"
        )
        connection.execute("INSERT INTO recording_key_secret VALUES (1, ?)", (secret,))
    ctx = multiprocessing.get_context("spawn")
    barrier, queue = ctx.Barrier(2), ctx.Queue()
    processes = [
        ctx.Process(target=_migration_actor, args=(str(path), barrier, queue)) for _ in range(2)
    ]
    started = []
    try:
        for process in processes:
            process.start()
            started.append(process)
        results = [queue.get(timeout=20) for _ in processes]
        for process in processes:
            process.join(timeout=20)
            assert process.exitcode == 0
        assert [r[0] for r in results] == ["ok", "ok"], results
        for _, row, saved_secret in results:
            assert row["token"] == "legacy-token"
            assert row["project_workspace"] == "/legacy/workspace"
            assert row["kind"] == "review" and row["capabilities"] == ["play"]
            assert saved_secret == secret
        with closing(sqlite3.connect(path)) as observer:
            assert observer.execute("SELECT token FROM active_shares").fetchall() == [
                ("legacy-token",)
            ]
            assert (
                observer.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
            )
    finally:
        for process in started:
            if process.is_alive():
                process.terminate()
            process.join()
            process.close()
        queue.close()
        queue.join_thread()


@pytest.mark.parametrize("stage", ["wal_read", "retry_sleep"])
def test_session_wal_interrupt_closes_real_connection_and_propagates_interrupt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stage: str
) -> None:
    original_connect = sqlite3.connect
    interrupt = KeyboardInterrupt("cancel session initialization")
    opened = []

    def open_connection(*args: Any, **kwargs: Any) -> ProbeConnection:
        connection = original_connect(*args, **kwargs, factory=ProbeConnection)
        connection.failures["PRAGMA journal_mode"] = (
            interrupt if stage == "wal_read" else sqlite3.OperationalError("database is locked")
        )
        opened.append(connection)
        return connection

    def interrupt_sleep(seconds: float) -> None:
        raise interrupt

    monkeypatch.setattr(session_sqlite.sqlite3, "connect", open_connection)
    if stage == "retry_sleep":
        monkeypatch.setattr(session_sqlite.time, "sleep", interrupt_sleep)
    try:
        with pytest.raises(KeyboardInterrupt) as caught:
            session_sqlite.connect_session_db(tmp_path / "session.db")
        assert caught.value is interrupt
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            opened[0].execute("SELECT 1")
    finally:
        for connection in opened:
            connection.close()


def test_secret_rollback_interrupt_propagates_with_original_commit_context_and_closes_owner(
    tmp_path: Path,
) -> None:
    path = tmp_path / "registry.db"
    registry = SqliteShareRegistry(path)
    poisoned = ProbeConnection(str(path), isolation_level=None)
    poisoned.row_factory = sqlite3.Row
    registry._conn.close()
    registry._conn = poisoned
    original = sqlite3.OperationalError("original commit failure")
    interrupt = KeyboardInterrupt("rollback cancelled")
    poisoned.failures["COMMIT"] = original
    poisoned.failures["ROLLBACK"] = interrupt
    try:
        with pytest.raises(KeyboardInterrupt) as caught:
            registry.recording_key_secret()
        assert caught.value is interrupt
        assert caught.value.__context__ is original
        with pytest.raises(sqlite3.ProgrammingError, match="closed"):
            poisoned.execute("SELECT 1")
        with closing(sqlite3.connect(path)) as observer:
            assert observer.execute("SELECT secret FROM recording_key_secret").fetchall() == []
        secret = registry.recording_key_secret()
        assert isinstance(secret, bytes) and len(secret) == 32
        with closing(sqlite3.connect(path)) as observer:
            assert (
                observer.execute("SELECT secret FROM recording_key_secret").fetchone()[0] == secret
            )
    finally:
        registry.close()


def test_registry_rollback_cancellation_closes_owner_and_retains_commit_context(tmp_path):
    registry = SqliteShareRegistry(tmp_path / "registry.db")
    try:
        secret = registry.recording_key_secret()
        registry.claim_active(_share_template(token="durable-token"))
        registry._conn.close()
        poisoned = ProbeConnection(str(registry.db_path), isolation_level=None)
        poisoned.row_factory = sqlite3.Row
        registry._conn = poisoned
        original = sqlite3.OperationalError("commit failed")
        cancellation = KeyboardInterrupt()
        poisoned.failures["COMMIT"] = original
        poisoned.failures["ROLLBACK"] = cancellation
        with pytest.raises(KeyboardInterrupt) as caught:
            registry.release_claim("durable-token")
        assert caught.value is cancellation
        assert caught.value.__context__ is original
        assert poisoned.closed
        assert registry.get_active("durable-token") is not None
        assert registry.recording_key_secret() == secret
        assert registry.release_claim("durable-token")
        with closing(sqlite3.connect(registry.db_path)) as observer:
            assert observer.execute("SELECT token FROM active_shares").fetchall() == []
    finally:
        registry.close()
