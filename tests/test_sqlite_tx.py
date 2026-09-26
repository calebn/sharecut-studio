"""``immediate_transaction``: commit, body failure, COMMIT failure, ROLLBACK failure."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from podcast_mcp.util.sqlite_tx import immediate_transaction, is_sqlite_busy
from sqlite_helpers import FailingConnection


@pytest.fixture
def conn(tmp_path: Path):
    c = sqlite3.connect(tmp_path / "t.db", isolation_level=None)
    c.execute("CREATE TABLE t (x INTEGER)")
    yield c
    c.close()


def _count(path: Path) -> int:
    other = sqlite3.connect(path)
    try:
        return int(other.execute("SELECT COUNT(*) FROM t").fetchone()[0])
    finally:
        other.close()


def test_commit_is_visible_to_another_connection(conn, tmp_path):
    with immediate_transaction(conn):
        conn.execute("INSERT INTO t VALUES (1)")
    assert _count(tmp_path / "t.db") == 1


def test_body_failure_rolls_back(conn, tmp_path):
    with pytest.raises(RuntimeError), immediate_transaction(conn):
        conn.execute("INSERT INTO t VALUES (1)")
        raise RuntimeError("body")
    assert not conn.in_transaction
    assert _count(tmp_path / "t.db") == 0


def test_commit_failure_rolls_back(conn, tmp_path):
    failing = FailingConnection(conn, "COMMIT")
    with pytest.raises(sqlite3.OperationalError), immediate_transaction(failing):  # type: ignore[arg-type]
        failing.execute("INSERT INTO t VALUES (1)")
    assert not conn.in_transaction
    assert _count(tmp_path / "t.db") == 0


def test_rollback_failure_keeps_the_original_error(conn):
    failing = FailingConnection(conn, "ROLLBACK")
    with pytest.raises(RuntimeError, match="body"), immediate_transaction(failing):  # type: ignore[arg-type]
        raise RuntimeError("body")
    if conn.in_transaction:
        conn.execute("ROLLBACK")


def test_is_sqlite_busy_detects_a_held_write_lock(tmp_path):
    path = tmp_path / "busy.db"
    holder = sqlite3.connect(path, isolation_level=None)
    holder.execute("PRAGMA journal_mode=WAL")
    holder.execute("CREATE TABLE t (x INTEGER)")
    other = sqlite3.connect(path, isolation_level=None, timeout=0.05)
    holder.execute("BEGIN IMMEDIATE")
    try:
        with pytest.raises(sqlite3.OperationalError) as info:
            other.execute("INSERT INTO t VALUES (1)")
        assert is_sqlite_busy(info.value)
    finally:
        holder.execute("ROLLBACK")
        holder.close()
        other.close()


@pytest.mark.parametrize(
    ("exc", "busy"),
    [
        (sqlite3.OperationalError("database is locked"), True),
        (sqlite3.OperationalError("injected failure"), False),
        (sqlite3.IntegrityError("database is locked"), False),
        (TimeoutError("lock"), False),
    ],
)
def test_is_sqlite_busy_without_an_error_code(exc, busy):
    assert is_sqlite_busy(exc) is busy
