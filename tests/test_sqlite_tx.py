"""``immediate_transaction``: commit, body failure, COMMIT failure, ROLLBACK failure."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from sqlite_helpers import FailingConnection

from podcast_mcp.util.sqlite_tx import immediate_transaction


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
