"""Shared session SQLite initialization stays safe under concurrent stores."""

from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from typing import Any
from unittest.mock import Mock

import pytest

from podcast_mcp.services.record.live_comments import RecordLiveCommentStore
from podcast_mcp.services.record.participants import RecordParticipantStore
from podcast_mcp.services.record.upload import RecordUploadStore
from podcast_mcp.services.session_sync import sqlite as session_sqlite
from podcast_mcp.services.session_sync.log import SyncStore


def test_concurrent_store_construction_initializes_wal_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "sync.db"
    start = Barrier(4)
    connect = sqlite3.connect
    wal_writes: list[str] = []

    def observed_connect(*args: Any, **kwargs: Any) -> sqlite3.Connection:
        connection = connect(*args, **kwargs)

        def observe(sql: str) -> None:
            if sql.lower() == "pragma journal_mode=wal":
                wal_writes.append(sql)

        connection.set_trace_callback(observe)
        return connection

    monkeypatch.setattr(sqlite3, "connect", observed_connect)
    constructors = (
        lambda: SyncStore(path, table_prefix="record_"),
        lambda: RecordParticipantStore(path),
        lambda: RecordLiveCommentStore(path),
        lambda: RecordUploadStore(path),
    )

    def construct_store(index: int) -> None:
        start.wait()
        store = constructors[index]()
        store.close()

    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(construct_store, range(4)))

    with sqlite3.connect(path) as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert len(wal_writes) == 1


def test_wal_initialization_does_not_disturb_active_writer(tmp_path: Path) -> None:
    path = tmp_path / "sync.db"
    seed = RecordParticipantStore(path)
    seed.close()
    writer = sqlite3.connect(path, isolation_level=None)
    writer.execute("BEGIN IMMEDIATE")
    writer.execute(
        "INSERT INTO record_participants VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("p1", "s", "t", "guest", "A", "l", 1, 1, 1),
    )
    connection = RecordParticipantStore(path)
    assert connection._conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    connection.close()
    writer.rollback()
    writer.close()


@pytest.mark.parametrize(
    ("journal_mode", "failure"),
    [
        (None, RuntimeError("could not read journal mode")),
        ("delete", RuntimeError("could not enable WAL")),
    ],
)
def test_pragma_failure_closes_connection_and_propagates_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    journal_mode: str | None,
    failure: RuntimeError,
) -> None:
    connection = Mock()
    if journal_mode is None:
        connection.execute.side_effect = failure
    else:
        connection.execute.side_effect = [
            Mock(fetchone=Mock(return_value=(journal_mode,))),
            failure,
        ]
    monkeypatch.setattr(session_sqlite.sqlite3, "connect", Mock(return_value=connection))

    with pytest.raises(RuntimeError, match=str(failure)):
        session_sqlite.connect_session_db(tmp_path / "sync.db")

    connection.close.assert_called_once_with()


def test_wal_initialization_retries_while_another_process_holds_the_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = Mock()
    connection.execute.side_effect = [
        sqlite3.OperationalError("database is locked"),
        Mock(fetchone=Mock(return_value=("wal",))),
    ]
    monkeypatch.setattr(session_sqlite.sqlite3, "connect", Mock(return_value=connection))
    sleep = Mock()
    monkeypatch.setattr(session_sqlite.time, "sleep", sleep)

    assert session_sqlite.connect_session_db(tmp_path / "sync.db") is connection

    sleep.assert_called_once_with(session_sqlite._WAL_INIT_RETRY_SEC)
    connection.close.assert_not_called()


def test_wal_initialization_gives_up_after_the_deadline(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = Mock()
    connection.execute.side_effect = sqlite3.OperationalError("database is locked")
    monkeypatch.setattr(session_sqlite.sqlite3, "connect", Mock(return_value=connection))
    monkeypatch.setattr(session_sqlite, "_WAL_INIT_TIMEOUT_SEC", 0.0)
    monkeypatch.setattr(session_sqlite.time, "sleep", Mock())

    with pytest.raises(sqlite3.OperationalError, match="locked"):
        session_sqlite.connect_session_db(tmp_path / "sync.db")

    connection.close.assert_called_once_with()


def test_wal_initialization_does_not_retry_other_sqlite_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = Mock()
    connection.execute.side_effect = sqlite3.OperationalError("disk I/O error")
    monkeypatch.setattr(session_sqlite.sqlite3, "connect", Mock(return_value=connection))
    sleep = Mock()
    monkeypatch.setattr(session_sqlite.time, "sleep", sleep)

    with pytest.raises(sqlite3.OperationalError, match="disk I/O"):
        session_sqlite.connect_session_db(tmp_path / "sync.db")

    sleep.assert_not_called()
    connection.close.assert_called_once_with()
