"""Shared session SQLite initialization stays safe under concurrent stores."""

from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from typing import Any

import pytest

from podcast_mcp.services.record.live_comments import RecordLiveCommentStore
from podcast_mcp.services.record.participants import RecordParticipantStore
from podcast_mcp.services.record.upload import RecordUploadStore
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
