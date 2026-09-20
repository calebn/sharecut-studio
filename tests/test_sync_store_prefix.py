"""SyncStore table_prefix isolates record tables from DAW commands."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.services.session_sync.log import SyncStore


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
