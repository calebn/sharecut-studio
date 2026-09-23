"""Ephemeral WebRTC Signal frames on the record hub."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace
from podcast_mcp.services.record.service import reset_record_runtime_for_tests
from podcast_mcp.services.session_sync.log import cached_sync_store
from podcast_mcp.services.session_sync.service import sync_db_path
from podcast_mcp.services.share import ShareService


def _isolate() -> None:
    reset_record_runtime_for_tests()


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _room(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate()
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    return ws, room, TestClient(create_app())


def _join(wsock, *, name: str, seq: int = 1):
    wsock.send_json(
        {
            "type": "Record",
            "command_type": "Join",
            "payload": {"display_name": name},
            "client_seq": seq,
        }
    )


def _drain_until(wsock, predicate, *, n: int = 20):
    for _ in range(n):
        msg = wsock.receive_json()
        if predicate(msg):
            return msg
    raise AssertionError("expected message not received")


def test_filter_record_event_drops_signal_not_addressed():
    from podcast_mcp.services.record.service import filter_record_event_for_guest

    ev = {"plane": "record", "type": "Signal", "from": "p_a", "to": "p_b"}
    assert filter_record_event_for_guest(ev, participant_id="p_c", role="guest") is None
    kept = filter_record_event_for_guest(ev, participant_id="p_b", role="guest")
    assert kept is not None and kept["to"] == "p_b"
    from pydantic import ValidationError

    from podcast_mcp.services.record.signal import validate_signal_payload

    with pytest.raises(ValidationError):
        validate_signal_payload(
            {
                "to": "p_b",
                "description": {"type": "offer", "sdp": "v=0"},
                "candidate": {"candidate": "x"},
            }
        )
    cleaned = validate_signal_payload(
        {
            "to": "p_b",
            "connected_wall_ms": 12,
            "description": {"type": "offer", "sdp": "v=0"},
        }
    )
    assert cleaned["connected_wall_ms"] == 12


def test_fanout_record_signal_authz():
    from podcast_mcp.services.record.commands import RecordAuthzError
    from podcast_mcp.services.record.signal import fanout_record_signal

    with pytest.raises(ValueError, match="join_first"):
        fanout_record_signal("record:x", from_id="", payload={"to": "p_b"}, role="guest")
    with pytest.raises(RecordAuthzError):
        fanout_record_signal(
            "record:x",
            from_id="p_a",
            payload={"to": "p_b", "description": {"type": "offer", "sdp": "v=0"}},
            role="guest",
            capabilities=["comment"],
        )


def test_signal_fans_out_and_is_not_persisted(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws?name=Ava") as a:
        _join(a, name="Ava")
        echo_a = _drain_until(a, lambda m: m.get("type") == "Echo")
        pid_a = echo_a["participant_id"]
        _drain_until(a, lambda m: m.get("type") == "Snapshot")
        with client.websocket_connect(f"/api/rec/{token}/ws?name=Bea") as b:
            _join(b, name="Bea")
            echo_b = _drain_until(b, lambda m: m.get("type") == "Echo")
            pid_b = echo_b["participant_id"]
            _drain_until(b, lambda m: m.get("type") == "Snapshot")
            _drain_until(a, lambda m: m.get("type") == "Applied")
            a.send_json(
                {
                    "type": "Record",
                    "command_type": "Signal",
                    "payload": {
                        "to": pid_b,
                        "description": {"type": "offer", "sdp": "v=0"},
                    },
                    "client_seq": 2,
                }
            )
            ack = _drain_until(a, lambda m: m.get("command_type") == "Signal")
            assert ack["type"] == "Echo"
            assert "snapshot" not in ack
            got = _drain_until(
                b,
                lambda m: m.get("type") == "Signal" and m.get("to") == pid_b,
                n=40,
            )
            assert got["from"] == pid_a
            assert got["description"]["sdp"] == "v=0"
            store = cached_sync_store(sync_db_path(ws.project), table_prefix="record_")
            types = [row["type"] for row in store.commands_after(0)]
            assert "Signal" not in types


def test_signal_rejects_self_and_unknown_payload(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws?name=Ava") as sock:
        _join(sock, name="Ava")
        echo = _drain_until(sock, lambda m: m.get("type") == "Echo")
        pid = echo["participant_id"]
        _drain_until(sock, lambda m: m.get("type") == "Snapshot")
        sock.send_json(
            {
                "type": "Record",
                "command_type": "Signal",
                "payload": {"to": pid, "description": {"type": "offer", "sdp": "v=0"}},
                "client_seq": 2,
            }
        )
        err = _drain_until(sock, lambda m: m.get("type") == "Error")
        assert err["code"] == "invalid_state"
        sock.send_json(
            {
                "type": "Record",
                "command_type": "Signal",
                "payload": {"to": "p_other"},
                "client_seq": 3,
            }
        )
        err2 = _drain_until(sock, lambda m: m.get("type") == "Error")
        assert err2["code"] == "invalid_state"
        sock.send_json(
            {
                "type": "Record",
                "command_type": "Signal",
                "payload": {
                    "to": "p_missing",
                    "description": {"type": "offer", "sdp": "v=0"},
                },
                "client_seq": 4,
            }
        )
        err3 = _drain_until(sock, lambda m: m.get("type") == "Error")
        assert err3["code"] == "invalid_state"


def test_host_signal_reaches_guest(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    url = f"/api/session/ws?path={quote(str(ws.path))}&client_id=host-a&role=viewer&label=Host"
    with client.websocket_connect(url) as host:
        _drain_until(host, lambda m: m.get("plane") == "record", n=40)
        with client.websocket_connect(f"/api/rec/{token}/ws?name=Ava") as guest:
            _join(guest, name="Ava")
            echo = _drain_until(guest, lambda m: m.get("type") == "Echo")
            pid = echo["participant_id"]
            _drain_until(guest, lambda m: m.get("type") == "Snapshot")
            host.send_json(
                {
                    "type": "Record",
                    "command_type": "Signal",
                    "payload": {
                        "to": pid,
                        "candidate": {"candidate": "candidate:1", "sdpMid": "0"},
                    },
                    "client_seq": 9,
                }
            )
            got = _drain_until(
                guest,
                lambda m: m.get("type") == "Signal" and m.get("from") == "p_host",
                n=40,
            )
            assert got["to"] == pid
            assert got["candidate"]["candidate"] == "candidate:1"
