"""``list_record_sessions``: open and ended rooms, landed numbers, ordering, missing snapshots."""

from __future__ import annotations

from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.record import list_record_sessions
from podcast_mcp.services.record import sessions as sessions_module
from podcast_mcp.services.record.landing_math import record_source_prefix
from test_record_landing import _isolate, _land_session, _seed


def _ws(minimal_project, sample_wav):
    _isolate()
    return _seed(minimal_project, sample_wav)


def test_open_room_is_listed_unnumbered_and_unlanded(minimal_project, sample_wav, tmp_workspace):
    ws = _ws(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    [item] = list_record_sessions(ws.project)
    assert item["session_id"] == room["session_id"]
    assert item["state"] == "open"
    assert item["number"] is None
    assert item["landed"] is False
    assert item["ended_at"] is None
    assert item["target_kind"] == "end"
    assert item["takes"] == []


def test_no_rooms_and_no_landing_lists_nothing(minimal_project, sample_wav, tmp_workspace):
    ws = _ws(minimal_project, sample_wav)
    assert list_record_sessions(ws.project) == []


def test_ended_landed_room_keeps_takes_participants_and_number(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _ws(minimal_project, sample_wav)
    room, _landed = _land_session(ws, take_ms=3_000)
    sid = room["session_id"]
    ShareService(ws).revoke_room(sid)
    [item] = list_record_sessions(ws.project)
    assert item["state"] == "ended"
    assert item["ended_at"]
    assert item["number"] == 1
    assert item["landed"] is True
    assert item["takes"] == [{"take_index": 0, "recording_ms": 3_000}]
    guests = [p for p in item["participants"] if p["role"] == "guest"]
    assert len(guests) == 1
    landed_tracks = {
        c.track_id for c in ws.project.clips if c.source_id.startswith(record_source_prefix(sid))
    }
    assert guests[0]["track_id"] in landed_tracks


def test_two_sessions_are_ordered_oldest_first(minimal_project, sample_wav, tmp_workspace):
    ws = _ws(minimal_project, sample_wav)
    first, _ = _land_session(ws)
    ShareService(ws).revoke_room(first["session_id"])
    second = ShareService(ws).create_record_room()
    items = list_record_sessions(ws.project)
    assert [i["session_id"] for i in items] == [first["session_id"], second["session_id"]]
    assert [i["state"] for i in items] == ["ended", "open"]
    assert [i["number"] for i in items] == [1, None]
    assert items[0]["takes"] == [] and items[0]["landed"] is True


def test_missing_snapshot_returns_what_the_project_holds(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _ws(minimal_project, sample_wav)
    room, _ = _land_session(ws)

    def boom(*_a, **_k):
        raise RuntimeError("store gone")

    monkeypatch.setattr(sessions_module.RecordSessionService, "snapshot", boom)
    [item] = list_record_sessions(ws.project)
    assert item["session_id"] == room["session_id"]
    assert item["takes"] == []
    assert item["participants"] == []
    assert item["number"] == 1
    assert item["target_kind"] == "end"
    assert item["landed"] is True


def test_sessions_route_is_host_only_and_returns_the_list(
    minimal_project, sample_wav, tmp_workspace
):
    ws = _ws(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    client = TestClient(create_app())
    res = client.get("/api/record/sessions", params={"path": str(ws.path)})
    assert res.status_code == 200, res.text
    assert [s["session_id"] for s in res.json()["sessions"]] == [room["session_id"]]


def test_revoked_row_without_revoked_at_has_no_end_time() -> None:
    row = {"revoked": True, "created_at": "2026-01-01T00:00:00+00:00"}
    assert sessions_module._ended_at([row]) is None
    assert sessions_module._ended_at([{**row, "revoked_at": "2026-01-02T00:00:00+00:00"}]) == (
        "2026-01-02T00:00:00+00:00"
    )
    assert sessions_module._ended_at([{"revoked_at": "x", "revoked": False}]) is None
