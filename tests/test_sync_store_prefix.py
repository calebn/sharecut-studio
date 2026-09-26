"""SyncStore table_prefix isolates record tables from DAW commands."""

from __future__ import annotations

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from podcast_mcp.services.session_sync.log import SyncStore
from sqlite_helpers import FailingConnection


def test_record_prefix_creates_prefixed_tables_without_touching_commands(
    tmp_path: Path,
) -> None:
    path = tmp_path / "sync.db"
    daw = SyncStore(path)
    daw.append_command(
        command_id="c1",
        client_id="viewer",
        client_seq=1,
        role="viewer",
        type="SetPlayhead",
        payload={"playhead_sec": 1.0},
        causation_id=None,
    )
    rec = SyncStore(path, table_prefix="record_")
    rec.append_command(
        command_id="r1",
        client_id="guest",
        client_seq=1,
        role="guest",
        type="Join",
        payload={"display_name": "Ava"},
        causation_id=None,
    )
    names = {
        row[0]
        for row in daw._conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    assert "commands" in names
    assert "record_commands" in names
    assert "record_snapshot" in names
    assert "record_clients" in names
    daw_rows = daw.commands_after(0)
    rec_rows = rec.commands_after(0)
    assert [r["command_id"] for r in daw_rows] == ["c1"]
    assert [r["command_id"] for r in rec_rows] == ["r1"]
    rec.close()
    daw.close()


def test_record_prefix_reset_clears_commands_and_snapshot(tmp_path: Path) -> None:
    path = tmp_path / "sync.db"
    rec = SyncStore(path, table_prefix="record_")
    rec.append_command(
        command_id="r1",
        client_id="guest",
        client_seq=1,
        role="guest",
        type="Join",
        payload={"display_name": "Ava"},
        causation_id=None,
    )
    rec.put_snapshot(1, {"session_id": "old", "state": "recording"})
    rec.reset({"session_id": "new", "state": "lobby"})
    assert rec.commands_after(0) == []
    snap = rec.get_snapshot() or {}
    assert snap["session_id"] == "new"
    assert snap["state"] == "lobby"
    rec.close()


def test_invalid_table_prefix_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="invalid table_prefix"):
        SyncStore(tmp_path / "x.db", table_prefix="record-")


def test_reset_guard_can_refuse_before_wipe(tmp_path: Path) -> None:
    rec = SyncStore(tmp_path / "sync.db", table_prefix="record_")
    rec.put_snapshot(1, {"session_id": "old", "state": "recording"})

    def guard(raw: dict | None) -> None:
        if raw and raw.get("state") == "recording":
            raise ValueError("open take")

    with pytest.raises(ValueError, match="open take"):
        rec.reset({"session_id": "new", "state": "lobby"}, guard=guard)
    snap = rec.get_snapshot() or {}
    assert snap["session_id"] == "old"
    rec.close()


def test_mutate_snapshot_skips_write_on_none(tmp_path: Path) -> None:
    rec = SyncStore(tmp_path / "sync.db", table_prefix="record_")
    rec.put_snapshot(1, {"session_id": "old", "state": "recording"})
    rec.mutate_snapshot(lambda _raw: None)
    snap = rec.get_snapshot() or {}
    assert snap["state"] == "recording"
    rec.mutate_snapshot(lambda raw: {**raw, "state": "paused"})
    snap = rec.get_snapshot() or {}
    assert snap["state"] == "paused"
    rec.close()


def test_mutate_snapshot_returns_none_when_empty(tmp_path: Path) -> None:
    rec = SyncStore(tmp_path / "sync.db", table_prefix="record_")
    assert rec.mutate_snapshot(lambda raw: raw) is None
    rec.close()


def _record_append(store, command_id, seq, apply_fn, *, side_effect_fn=None):
    return store.append_and_apply(
        command_id=command_id,
        client_id="guest",
        client_seq=seq,
        role="guest",
        type="Join",
        payload={"n": seq},
        causation_id=None,
        apply_fn=apply_fn,
        empty_snap_fn=lambda: {"server_seq": 0},
        side_effect_fn=side_effect_fn,
    )


def _count_apply(snapshot, row):
    return {**snapshot, "server_seq": row["server_seq"], "n": int(snapshot.get("n") or 0) + 1}


def test_record_prefix_independent_connections_materialize_in_order(tmp_path: Path) -> None:
    db_path = tmp_path / "sync.db"
    first_store = SyncStore(db_path, table_prefix="record_")
    second_store = SyncStore(db_path, table_prefix="record_")
    first_entered, second_done = threading.Event(), threading.Event()

    def slow_first(snapshot, row):
        first_entered.set()
        second_done.wait(timeout=1.0)
        return _count_apply(snapshot, row)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(_record_append, first_store, "first", 1, slow_first)
        assert first_entered.wait(timeout=5.0)
        second = pool.submit(_record_append, second_store, "second", 2, _count_apply)
        second.add_done_callback(lambda _: second_done.set())
        assert first.result()[0]["server_seq"] == 1
        assert second.result()[0]["server_seq"] == 2
    snapshot = first_store.get_snapshot()
    assert snapshot is not None
    assert (snapshot["server_seq"], snapshot["n"]) == (2, 2)
    first_store.close()
    second_store.close()


def test_record_prefix_failed_apply_rolls_back_command_so_retry_applies(tmp_path: Path) -> None:
    store = SyncStore(tmp_path / "sync.db", table_prefix="record_")

    def boom(_snapshot, _row):
        raise RuntimeError("apply failed")

    with pytest.raises(RuntimeError):
        _record_append(store, "c1", 1, boom)
    assert store.commands_after(0) == []
    assert store.get_snapshot() is None
    _row, _snap, idempotent = _record_append(store, "c1", 1, _count_apply)
    assert idempotent is False
    store.close()


def test_side_effect_commits_and_rolls_back_with_its_command(tmp_path: Path) -> None:
    store = SyncStore(tmp_path / "sync.db", table_prefix="record_")
    store._conn.execute("CREATE TABLE side (x INTEGER)")

    def write_side(conn, row):
        conn.execute("INSERT INTO side (x) VALUES (?)", (row["server_seq"],))

    def fail_side(conn, row):
        write_side(conn, row)
        raise RuntimeError("side effect failed")

    _record_append(store, "ok", 1, _count_apply, side_effect_fn=write_side)
    with pytest.raises(RuntimeError):
        _record_append(store, "bad", 2, _count_apply, side_effect_fn=fail_side)
    assert [r[0] for r in store._conn.execute("SELECT x FROM side").fetchall()] == [1]
    assert [r["command_id"] for r in store.commands_after(0)] == ["ok"]
    store.close()


def test_mutate_snapshot_is_one_write_transaction(tmp_path: Path) -> None:
    db_path = tmp_path / "sync.db"
    a = SyncStore(db_path, table_prefix="record_")
    b = SyncStore(db_path, table_prefix="record_")
    _record_append(a, "seed", 1, _count_apply)
    entered, release = threading.Event(), threading.Event()

    def mutator(body):
        entered.set()
        release.wait(timeout=5.0)
        return {**body, "field": "mine"}

    with ThreadPoolExecutor(max_workers=2) as pool:
        mutate = pool.submit(a.mutate_snapshot, mutator)
        assert entered.wait(timeout=5.0)
        append = pool.submit(_record_append, b, "later", 2, _count_apply)
        release.set()
        mutate.result()
        appended = append.result()
    assert appended[0]["server_seq"] == 2
    snapshot = a.get_snapshot()
    assert snapshot is not None
    assert (snapshot["server_seq"], snapshot["field"], snapshot["n"]) == (2, "mine", 2)
    a.close()
    b.close()


def test_failed_commit_rolls_back_and_the_next_write_commits(tmp_path: Path) -> None:
    db_path = tmp_path / "sync.db"
    store = SyncStore(db_path, table_prefix="record_")
    real = store._conn
    store._conn = FailingConnection(real, "COMMIT")  # type: ignore[assignment]
    try:
        with pytest.raises(sqlite3.OperationalError):
            _record_append(store, "lost", 1, _count_apply)
    finally:
        store._conn = real
    assert not real.in_transaction
    _record_append(store, "kept", 2, _count_apply)
    other = SyncStore(db_path, table_prefix="record_")
    try:
        assert [r["command_id"] for r in other.commands_after(0)] == ["kept"]
    finally:
        other.close()
    store.close()


def test_nested_write_transaction_joins_the_outer_one(tmp_path: Path) -> None:
    store = SyncStore(tmp_path / "sync.db", table_prefix="record_")
    with pytest.raises(RuntimeError), store.write_transaction():
        _record_append(store, "inner", 1, _count_apply)
        raise RuntimeError("outer failed")
    assert store.commands_after(0) == []
    store.close()
