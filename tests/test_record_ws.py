"""Record WebSocket + host HTTP twins."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import Clip, Track, TrackRole, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.record.commands import (
    CLIENT_VISIBLE_AUTHZ_CODES,
    RecordAuthzError,
    RecordCommand,
)
from podcast_mcp.services.record.control import RecordControlService
from podcast_mcp.services.record.reducer import RecordStateError
from podcast_mcp.services.record.service import (
    RecordSessionService,
    apply_record_ws_message,
    reset_record_runtime_for_tests,
    route_record_ws_message,
)
from podcast_mcp.util.coded_error import GENERIC_GUEST_MESSAGE


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


def _join(wsock, *, name: str, participant_id=None, lease=None, seq: int = 1):
    payload = {"display_name": name}
    if participant_id:
        payload["participant_id"] = participant_id
        payload["lease"] = lease
    wsock.send_json(
        {
            "type": "Record",
            "command_type": "Join",
            "payload": payload,
            "client_seq": seq,
        }
    )


def _drain_until(wsock, predicate, *, n: int = 20):
    for _ in range(n):
        msg = wsock.receive_json()
        if predicate(msg):
            return msg
    raise AssertionError("expected message not received")


def test_guest_join_echo_and_snapshot(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws?name=Ava") as sock:
        _join(sock, name="Ava")
        echo = _drain_until(sock, lambda m: m.get("type") == "Echo")
        assert echo["plane"] == "record"
        assert echo["participant_id"].startswith("p_")
        assert echo["lease"]
        snap = _drain_until(sock, lambda m: m.get("type") == "Snapshot")
        people = snap["snapshot"]["participants"]
        assert any(p["display_name"] == "Ava" for p in people)
        blob = str(snap)
        assert "lease" not in blob.lower() or "lease_hash" not in blob.lower()
        for person in people:
            assert "lease" not in person


def test_producer_consent_and_guest_start_forbidden(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    with client.websocket_connect(f"/api/rec/{room['producer']['token']}/ws") as prod:
        _join(prod, name="Pat")
        _drain_until(prod, lambda m: m.get("type") == "Snapshot")
        prod.send_json(
            {
                "type": "Record",
                "command_type": "Consent",
                "payload": {"accepted": True},
                "client_seq": 2,
            }
        )
        err = _drain_until(prod, lambda m: m.get("type") == "Error")
        assert err["code"] == "forbidden"
    with client.websocket_connect(f"/api/rec/{room['guest']['token']}/ws") as guest:
        _join(guest, name="Ava")
        _drain_until(guest, lambda m: m.get("type") == "Snapshot")
        guest.send_json(
            {
                "type": "Record",
                "command_type": "Start",
                "payload": {},
                "client_seq": 2,
            }
        )
        err = _drain_until(guest, lambda m: m.get("type") == "Error")
        assert err["code"] == "forbidden"


def test_host_start_blocked_until_consent(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    pre_join = client.post(
        "/api/record/command",
        json={"path": str(ws.path), "command_type": "Start", "payload": {}},
    )
    assert pre_join.status_code == 400
    with client.websocket_connect(f"/api/rec/{token}/ws") as guest:
        _join(guest, name="Ava")
        _drain_until(guest, lambda m: m.get("type") == "Snapshot")
        blocked = client.post(
            "/api/record/command",
            json={"path": str(ws.path), "command_type": "Start", "payload": {}},
        )
        assert blocked.status_code == 400
        guest.send_json(
            {
                "type": "Record",
                "command_type": "Consent",
                "payload": {"accepted": True},
                "client_seq": 2,
            }
        )
        _drain_until(
            guest,
            lambda m: any(
                p.get("role") == "guest" and p.get("consented") is True
                for p in (m.get("snapshot") or {}).get("participants") or []
            ),
        )
        ok = client.post(
            "/api/record/command",
            json={"path": str(ws.path), "command_type": "Start", "payload": {}},
        )
        assert ok.status_code == 200, ok.text
        applied = _drain_until(
            guest,
            lambda m: (
                m.get("type") == "Applied" and (m.get("snapshot") or {}).get("state") == "recording"
            ),
        )
        assert applied["plane"] == "record"
        assert "lease" not in str(applied.get("snapshot"))
        assert applied["snapshot"].get("start_blockers") == []


def test_guest_consent_seq_not_collapsed_by_host_cli_seq(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """A refused host CLI command burns a global seq; guest Join must still use frame seq 1."""
    ws, room, _client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    ctrl = RecordControlService(ws)
    with pytest.raises(RecordStateError, match=r"^cannot pause unless recording$"):
        ctrl.pause()
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    echo, _snap = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name="Ava",
        client_id="rec-guest",
        connection_id="c1",
        capabilities=["join", "monitor"],
        client_seq=1,
    )
    apply_record_ws_message(
        svc,
        {
            "type": "Record",
            "command_type": "Consent",
            "payload": {"accepted": True},
            "client_seq": 2,
        },
        client_id="rec-guest",
        role="guest",
        participant_id=echo["participant_id"],
        seq=2,
        capabilities=["join", "monitor"],
        connection_id="c1",
    )
    out = ctrl.start()
    assert out["state"] == "recording"
    assert out["start_blockers"] == []


def test_second_tab_lease_in_use(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws") as first:
        _join(first, name="Ava")
        echo = _drain_until(first, lambda m: m.get("type") == "Echo")
        pid, lease = echo["participant_id"], echo["lease"]
        with client.websocket_connect(f"/api/rec/{token}/ws") as second:
            _join(second, name="Ava", participant_id=pid, lease=lease)
            err = _drain_until(second, lambda m: m.get("type") == "Error")
            assert err["code"] == "lease_in_use"


@pytest.mark.parametrize("command_type", ["Signal", "Heartbeat", "Comment"])
def test_removed_guest_ws_closes_without_closing_other_guest(
    command_type, minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws") as removed:
        _join(removed, name="Ava")
        echo = _drain_until(removed, lambda m: m.get("type") == "Echo")
        _drain_until(removed, lambda m: m.get("type") == "Snapshot")
        with client.websocket_connect(f"/api/rec/{token}/ws") as other:
            _join(other, name="Bea")
            _drain_until(other, lambda m: m.get("type") == "Snapshot")
            response = client.post(
                "/api/record/command",
                json={
                    "path": str(ws.path),
                    "command_type": "RemoveParticipant",
                    "payload": {"participant_id": echo["participant_id"]},
                },
            )
            assert response.status_code == 200, response.text
            removed.send_json(
                {
                    "type": "Record",
                    "command_type": command_type,
                    "payload": {"body": "removed comment"} if command_type == "Comment" else {},
                    "client_seq": 2,
                }
            )
            with pytest.raises(WebSocketDisconnect) as closed:
                _drain_until(removed, lambda m: m.get("type") == "Echo")
            assert closed.value.code == 4403
            _drain_until(
                other,
                lambda m: (
                    m.get("type") == "Applied"
                    and m.get("command", {}).get("type") == "RemoveParticipant"
                ),
            )
            other.send_json(
                {"type": "Record", "command_type": "Heartbeat", "payload": {}, "client_seq": 2}
            )
            _drain_until(other, lambda m: m.get("command_type") == "Heartbeat")


def test_removed_guest_signal_dispatch_rejected(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, _client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    echo, _snap = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name="Ava",
        client_id="rec-ava",
        connection_id="ava-socket",
        capabilities=["join", "monitor"],
        client_seq=1,
    )
    RecordControlService(ws).submit_host(
        "RemoveParticipant", payload={"participant_id": echo["participant_id"]}
    )
    with pytest.raises(RecordStateError, match="participant removed"):
        route_record_ws_message(
            svc,
            {"type": "Record", "command_type": "Signal", "payload": {}, "client_seq": 2},
            client_id="rec-ava",
            role="guest",
            participant_id=echo["participant_id"],
            seq=2,
            capabilities=["join", "monitor"],
            connection_id="ava-socket",
        )
    before = svc._store.commands_after(0)
    for command_type in ("Heartbeat", "Comment"):
        with pytest.raises(RecordStateError, match="participant removed"):
            apply_record_ws_message(
                svc,
                {
                    "type": "Record",
                    "command_type": command_type,
                    "payload": {"id": "live-rejected", "body": "should not land"}
                    if command_type == "Comment"
                    else {},
                    "client_seq": 2,
                },
                client_id="rec-ava",
                role="guest",
                participant_id=echo["participant_id"],
                seq=2,
                capabilities=["join", "monitor", "comment"],
                connection_id="ava-socket",
            )
    assert svc._store.commands_after(0) == before
    assert svc.snapshot()["comments"] == []


def test_signal_and_removal_share_one_room_decision(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event, Thread, current_thread

    from podcast_mcp.services.record import service as service_mod

    ws, room, _client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    token = room["guest"]["token"]
    ava, _ = svc.join(
        token=token,
        role="guest",
        display_name="Ava",
        client_id="ava",
        connection_id="ava-socket",
        capabilities=["join", "monitor"],
        client_seq=1,
    )
    bea, _ = svc.join(
        token=token,
        role="guest",
        display_name="Bea",
        client_id="bea",
        connection_id="bea-socket",
        capabilities=["join", "monitor"],
        client_seq=1,
    )
    entered = Event()
    release = Event()
    remove_started = Event()
    signal_thread: Thread | None = None
    real_model = svc._model

    def paused_model():
        if current_thread() is signal_thread:
            entered.set()
            assert release.wait(3)
        return real_model()

    monkeypatch.setattr(svc, "_model", paused_model)
    sent: list[str] = []
    real_fanout = service_mod.fanout_record_signal

    def fanout(*args, **kwargs):
        sent.append(kwargs["from_id"])
        return real_fanout(*args, **kwargs)

    monkeypatch.setattr(service_mod, "fanout_record_signal", fanout)

    def signal():
        nonlocal signal_thread
        signal_thread = current_thread()
        return svc.signal(
            participant_id=ava["participant_id"],
            connection_id="ava-socket",
            payload={"to": bea["participant_id"], "candidate": {"candidate": "candidate"}},
            role="guest",
            capabilities=["monitor"],
        )

    def remove():
        remove_started.set()
        return RecordControlService(ws).submit_host(
            "RemoveParticipant", payload={"participant_id": ava["participant_id"]}
        )

    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="signal-review") as pool:
        signal_future = pool.submit(signal)
        assert entered.wait(3)
        remove_future = pool.submit(remove)
        assert remove_started.wait(3)
        assert not remove_future.done()
        release.set()
        assert signal_future.result(timeout=3)["type"] == "Echo"
        remove_future.result(timeout=3)
    with pytest.raises(RecordStateError, match="participant removed"):
        signal()
    assert sent == [ava["participant_id"]]
    with pytest.raises(ValueError, match="unknown_peer"):
        svc.signal(
            participant_id=bea["participant_id"],
            connection_id="bea-socket",
            payload={"to": ava["participant_id"], "candidate": {"candidate": "candidate"}},
            role="guest",
            capabilities=["monitor"],
        )


def test_removed_guest_ws_closes_on_room_event_without_inbound_frame(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws") as removed:
        _join(removed, name="Ava")
        echo = _drain_until(removed, lambda m: m.get("type") == "Echo")
        _drain_until(removed, lambda m: m.get("type") == "Snapshot")
        with client.websocket_connect(f"/api/rec/{token}/ws") as other:
            _join(other, name="Bea")
            _drain_until(other, lambda m: m.get("type") == "Snapshot")
            response = client.post(
                "/api/record/command",
                json={
                    "path": str(ws.path),
                    "command_type": "RemoveParticipant",
                    "payload": {"participant_id": echo["participant_id"]},
                },
            )
            assert response.status_code == 200, response.text
            with pytest.raises(WebSocketDisconnect) as closed:
                _drain_until(removed, lambda m: m.get("type") == "Echo")
            assert closed.value.code == 4403
            _drain_until(
                other,
                lambda m: (
                    m.get("type") == "Applied"
                    and m.get("command", {}).get("type") == "RemoveParticipant"
                ),
            )


def test_removed_guest_ws_closes_when_idle_without_room_event(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    import asyncio

    from podcast_mcp.gui.routes import record_share

    class QuietHub:
        def subscribe(self, _key, _loop):
            return asyncio.Queue()

        def unsubscribe(self, _key, _queue):
            return None

    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    monkeypatch.setattr(record_share, "get_hub", lambda: QuietHub())
    monkeypatch.setattr("podcast_mcp.gui.routes.guest_ws_common.GUEST_SHARE_RECHECK_S", 0.01)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws") as removed:
        _join(removed, name="Ava")
        echo = _drain_until(removed, lambda m: m.get("type") == "Echo")
        _drain_until(removed, lambda m: m.get("type") == "Snapshot")
        with client.websocket_connect(f"/api/rec/{token}/ws") as other:
            _join(other, name="Bea")
            _drain_until(other, lambda m: m.get("type") == "Snapshot")
            response = client.post(
                "/api/record/command",
                json={
                    "path": str(ws.path),
                    "command_type": "RemoveParticipant",
                    "payload": {"participant_id": echo["participant_id"]},
                },
            )
            assert response.status_code == 200, response.text
            with pytest.raises(WebSocketDisconnect) as closed:
                removed.receive_json()
            assert closed.value.code == 4403
            other.send_json(
                {"type": "Record", "command_type": "Heartbeat", "payload": {}, "client_seq": 2}
            )
            _drain_until(other, lambda m: m.get("command_type") == "Heartbeat")


def test_review_token_on_record_ws_rejected(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _isolate()
    ws = _seed_premix(minimal_project, sample_wav)
    from podcast_mcp.services.collaboration.review import ReviewService

    ver = ReviewService(ws).publish(label="x")
    share = ShareService(ws).create(review_version_id=ver["id"], capabilities=["play", "view"])
    client = TestClient(create_app())
    try:
        with client.websocket_connect(f"/api/rec/{share['token']}/ws") as sock:
            sock.receive_json()
            raise AssertionError("expected close")
    except Exception:
        pass


def test_oversize_and_revoked_token(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws") as sock:
        sock.send_text("x" * 5000)
        _join(sock, name="Ava")
        echo = _drain_until(sock, lambda m: m.get("type") == "Echo")
        assert echo["participant_id"]
    ShareService(ws).revoke_room(room["session_id"])
    try:
        with client.websocket_connect(f"/api/rec/{token}/ws") as sock:
            sock.receive_json()
            raise AssertionError("expected close")
    except Exception:
        pass


def test_record_state_404_without_room(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    _isolate()
    ws = _seed_premix(minimal_project, sample_wav)
    client = TestClient(create_app())
    res = client.get("/api/record/state", params={"path": str(ws.path)})
    assert res.status_code == 404
    posted = client.post(
        "/api/record/command",
        json={"path": str(ws.path), "command_type": "Start", "payload": {}},
    )
    assert posted.status_code == 404


def test_host_ws_attaches_record_plane_after_room_mint(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from urllib.parse import quote

    _isolate()
    ws = _seed_premix(minimal_project, sample_wav)
    client = TestClient(create_app())
    url = f"/api/host/ws?document_client_id=doc-test&path={quote(str(ws.path))}&client_id=host-a&role=viewer&label=Host"
    with client.websocket_connect(url) as host:
        first = host.receive_json()
        assert first["type"] == "Snapshot"
        ShareService(ws).create_record_room()
        host.send_json({"type": "Presence", "playhead_sec": 0, "client_seq": 2, "meta": {}})
        rec = _drain_until(host, lambda m: m.get("plane") == "record", n=40)
        assert rec["type"] in {"Echo", "Snapshot", "Applied"}
        assert rec["snapshot"]["state"] == "lobby"


def test_host_ws_joins_a_room_minted_after_it_opened_without_a_frame(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from urllib.parse import quote

    from podcast_mcp.services.record.state import HOST_PARTICIPANT_ID

    _isolate()
    monkeypatch.setattr("podcast_mcp.gui.routes.host.HOST_RECORD_ATTACH_POLL_S", 0.05)
    ws = _seed_premix(minimal_project, sample_wav)
    client = TestClient(create_app())
    url = f"/api/host/ws?document_client_id=doc-test&path={quote(str(ws.path))}&client_id=host-a&role=viewer&label=Host"
    with client.websocket_connect(url) as host:
        assert host.receive_json()["type"] == "Snapshot"
        created = ShareService(ws).create_record_room()
        svc = RecordSessionService(ws.project, session_id=created["session_id"])

        def host_on_roster(message):
            if message.get("plane") != "record":
                return False
            return any(
                person["participant_id"] == HOST_PARTICIPANT_ID
                for person in svc.snapshot()["participants"]
            )

        rec = _drain_until(host, host_on_roster, n=60)
        assert rec["snapshot"]["state"] == "lobby"
        roster = {p["participant_id"]: p for p in svc.snapshot()["participants"]}
        assert roster[HOST_PARTICIPANT_ID]["display_name"] == "Host"
        assert roster[HOST_PARTICIPANT_ID]["connected"] is True


def test_host_ws_joins_again_when_a_room_reset_clears_its_claim(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    import threading
    from urllib.parse import quote

    from podcast_mcp.services.record.service import (
        begin_record_session,
        connection_holds,
        record_hub_key,
    )
    from podcast_mcp.services.record.state import HOST_PARTICIPANT_ID

    _isolate()
    monkeypatch.setattr("podcast_mcp.gui.routes.host.HOST_RECORD_ATTACH_POLL_S", 0.05)
    real_join = RecordSessionService.join
    joins: list[str] = []
    armed = threading.Event()
    rejoined = threading.Event()

    def counting_join(self, *args, **kwargs):
        result = real_join(self, *args, **kwargs)
        if kwargs.get("role") == "host":
            joins.append(kwargs["connection_id"])
            if armed.is_set() and connection_holds(
                record_hub_key(self.project), HOST_PARTICIPANT_ID, kwargs["connection_id"]
            ):
                rejoined.set()
        return result

    monkeypatch.setattr(RecordSessionService, "join", counting_join)
    ws = _seed_premix(minimal_project, sample_wav)
    client = TestClient(create_app())
    url = f"/api/host/ws?document_client_id=doc-test&path={quote(str(ws.path))}&client_id=host-a&role=viewer&label=Host"
    with client.websocket_connect(url) as host:
        assert host.receive_json()["type"] == "Snapshot"
        created = ShareService(ws).create_record_room()
        _drain_until(host, lambda m: m.get("plane") == "record", n=40)
        begin_record_session(ws.project, created["session_id"])
        armed.set()
        hub = record_hub_key(ws.project)
        if not connection_holds(hub, HOST_PARTICIPANT_ID, joins[-1]):
            assert rejoined.wait(10)
        svc = RecordSessionService(ws.project, session_id=created["session_id"])
        roster = {p["participant_id"]: p for p in svc.snapshot()["participants"]}
        assert HOST_PARTICIPANT_ID in roster
        assert connection_holds(hub, HOST_PARTICIPANT_ID, joins[-1])


def test_host_record_watcher_survives_a_failed_poll(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    import threading
    from urllib.parse import quote

    from podcast_mcp.services.record.state import HOST_PARTICIPANT_ID

    _isolate()
    monkeypatch.setattr("podcast_mcp.gui.routes.host.HOST_RECORD_ATTACH_POLL_S", 0.05)
    real = RecordSessionService.active_session_id
    looked = threading.Event()
    armed = threading.Event()
    raised = threading.Event()

    def flaky(project):
        sid = real(project)
        if not threading.current_thread().name.startswith("AnyIO worker"):
            return sid
        if sid and armed.is_set() and not raised.is_set():
            raised.set()
            raise OSError("share store unavailable")
        looked.set()
        return sid

    monkeypatch.setattr(RecordSessionService, "active_session_id", staticmethod(flaky))
    ws = _seed_premix(minimal_project, sample_wav)
    client = TestClient(create_app())
    url = f"/api/host/ws?document_client_id=doc-test&path={quote(str(ws.path))}&client_id=host-a&role=viewer&label=Host"
    with client.websocket_connect(url) as host:
        assert host.receive_json()["type"] == "Snapshot"
        assert looked.wait(10)
        armed.set()
        created = ShareService(ws).create_record_room()
        rec = _drain_until(host, lambda m: m.get("plane") == "record", n=40)
        assert rec["snapshot"]["state"] == "lobby"
        assert raised.is_set()
        svc = RecordSessionService(ws.project, session_id=created["session_id"])
        roster = {p["participant_id"]: p for p in svc.snapshot()["participants"]}
        assert roster[HOST_PARTICIPANT_ID]["connected"] is True


def test_host_record_watcher_gives_up_on_a_room_whose_join_keeps_failing(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    import threading
    from urllib.parse import quote

    _isolate()
    monkeypatch.setattr("podcast_mcp.gui.routes.host.HOST_RECORD_ATTACH_POLL_S", 0.05)
    joins: list[int] = []
    first = threading.Event()
    looked = threading.Event()
    settled = threading.Event()
    polls: list[int] = []
    real = RecordSessionService.active_session_id

    def spy(project):
        sid = real(project)
        if threading.current_thread().name.startswith("AnyIO worker"):
            looked.set()
            if first.is_set():
                polls.append(1)
                if len(polls) >= 6:
                    settled.set()
        return sid

    monkeypatch.setattr(RecordSessionService, "active_session_id", staticmethod(spy))

    def broken_join(self, **kwargs):
        joins.append(1)
        first.set()
        raise OSError("share store unavailable")

    monkeypatch.setattr(RecordSessionService, "join", broken_join)
    ws = _seed_premix(minimal_project, sample_wav)
    client = TestClient(create_app())
    url = f"/api/host/ws?document_client_id=doc-test&path={quote(str(ws.path))}&client_id=host-a&role=viewer&label=Host"
    with client.websocket_connect(url) as host:
        assert host.receive_json()["type"] == "Snapshot"
        assert looked.wait(10)
        ShareService(ws).create_record_room()
        assert first.wait(10)
        assert settled.wait(10)
        assert len(joins) == 1


def test_host_record_watcher_detaches_when_the_room_closes(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    import threading
    from urllib.parse import quote

    from podcast_mcp.services.record.state import HOST_PARTICIPANT_ID

    _isolate()
    monkeypatch.setattr("podcast_mcp.gui.routes.host.HOST_RECORD_ATTACH_POLL_S", 0.05)
    real = RecordSessionService.disconnect
    left = threading.Event()

    def spy(self, participant_id, *, connection_id=None):
        if participant_id == HOST_PARTICIPANT_ID:
            left.set()
        return real(self, participant_id, connection_id=connection_id)

    monkeypatch.setattr(RecordSessionService, "disconnect", spy)
    ws = _seed_premix(minimal_project, sample_wav)
    client = TestClient(create_app())
    url = f"/api/host/ws?document_client_id=doc-test&path={quote(str(ws.path))}&client_id=host-a&role=viewer&label=Host"
    with client.websocket_connect(url) as host:
        assert host.receive_json()["type"] == "Snapshot"
        created = ShareService(ws).create_record_room()
        _drain_until(host, lambda m: m.get("plane") == "record", n=40)
        assert not left.is_set()
        ShareService(ws).revoke_room(created["session_id"])
        assert left.wait(5.0)


def test_two_host_session_sockets_survive_record_attach(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from urllib.parse import quote

    ws, _created, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    path = quote(str(ws.path))
    url_a = f"/api/host/ws?document_client_id=doc-test&path={path}&client_id=host-a&role=viewer&label=HostA"
    url_b = f"/api/host/ws?document_client_id=doc-test&path={path}&client_id=host-b&role=viewer&label=HostB"
    with client.websocket_connect(url_a) as host_a:
        assert host_a.receive_json()["type"] == "Snapshot"
        _drain_until(host_a, lambda m: m.get("plane") == "record")
        with client.websocket_connect(url_b) as host_b:
            assert host_b.receive_json()["type"] == "Snapshot"
            rec_b = _drain_until(host_b, lambda m: m.get("plane") == "record")
            assert rec_b["snapshot"]["state"] == "lobby"
            host_b.send_json({"type": "Presence", "playhead_sec": 0, "client_seq": 2, "meta": {}})
            echo = host_b.receive_json()
            assert echo.get("type") in {"Echo", "Applied", "Snapshot", "Presence"}


def test_closing_one_host_tab_keeps_p_host_connected(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from urllib.parse import quote

    from podcast_mcp.services.record.state import HOST_PARTICIPANT_ID

    ws, _created, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    path = quote(str(ws.path))
    url_a = f"/api/host/ws?document_client_id=doc-test&path={path}&client_id=host-a&role=viewer&label=HostA"
    url_b = f"/api/host/ws?document_client_id=doc-test&path={path}&client_id=host-b&role=viewer&label=HostB"
    with client.websocket_connect(url_a) as host_a:
        assert host_a.receive_json()["type"] == "Snapshot"
        _drain_until(host_a, lambda m: m.get("plane") == "record")
        with client.websocket_connect(url_b) as host_b:
            assert host_b.receive_json()["type"] == "Snapshot"
            _drain_until(host_b, lambda m: m.get("plane") == "record")
        svc = RecordSessionService(ws.project, session_id=_created["session_id"])
        host = next(
            p for p in svc.snapshot()["participants"] if p["participant_id"] == HOST_PARTICIPANT_ID
        )
        assert host["connected"] is True
        host_a.send_json({"type": "Presence", "playhead_sec": 1, "client_seq": 2, "meta": {}})
        echo = host_a.receive_json()
        assert echo.get("type") in {"Echo", "Applied", "Snapshot", "Presence"}


def test_host_ws_start_after_attach_is_not_join_idempotent(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from urllib.parse import quote

    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    url = f"/api/host/ws?document_client_id=doc-test&path={quote(str(ws.path))}&client_id=host-a&role=viewer&label=Host"
    with client.websocket_connect(url) as host:
        _drain_until(host, lambda m: m.get("plane") == "record")
        token = room["guest"]["token"]
        with client.websocket_connect(f"/api/rec/{token}/ws") as guest:
            _join(guest, name="Ava")
            _drain_until(guest, lambda m: m.get("type") == "Snapshot")
            guest.send_json(
                {
                    "type": "Record",
                    "command_type": "Consent",
                    "payload": {"accepted": True},
                    "client_seq": 2,
                }
            )
            _drain_until(
                guest,
                lambda m: any(
                    p.get("role") == "guest" and p.get("consented") is True
                    for p in (m.get("snapshot") or {}).get("participants") or []
                ),
            )
            host.send_json(
                {
                    "type": "Record",
                    "command_type": "Start",
                    "payload": {},
                    "client_seq": 1,
                }
            )
            started = _drain_until(
                host,
                lambda m: (m.get("snapshot") or {}).get("state") == "recording",
                n=40,
            )
            assert started["plane"] == "record"
            assert started["snapshot"].get("start_blockers") == []
            host.send_json(
                {
                    "type": "Record",
                    "command_type": "Start",
                    "payload": {},
                    "client_seq": 2,
                }
            )
            err = _drain_until(host, lambda m: m.get("type") == "Error", n=40)
            assert err["code"] == "invalid_state"


def test_second_record_room_starts_in_lobby(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, _client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    echo, _snap = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name="Ava",
        client_id="rec-guest",
        connection_id="c1",
        capabilities=["join", "monitor"],
        client_seq=1,
    )
    apply_record_ws_message(
        svc,
        {
            "type": "Record",
            "command_type": "Consent",
            "payload": {"accepted": True},
            "client_seq": 2,
        },
        client_id="rec-guest",
        role="guest",
        participant_id=echo["participant_id"],
        seq=2,
        capabilities=["join", "monitor"],
        connection_id="c1",
    )
    RecordControlService(ws).start()
    assert svc.snapshot()["state"] == "recording"
    with pytest.raises(RecordStateError, match="A take is open"):
        ShareService(ws).create_record_room()
    RecordControlService(ws).stop()
    second = ShareService(ws).create_record_room()
    fresh = RecordSessionService(ws.project, session_id=second["session_id"])
    assert fresh.snapshot()["state"] == "lobby"
    assert fresh.snapshot()["participants"] == []
    assert fresh.snapshot()["session_id"] == second["session_id"]


def test_stale_disconnect_does_not_leave_rejoined_guest(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.services.record.service import record_hub_key, release_connection

    ws, room, _client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    echo, _snap = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name="Ava",
        client_id="rec-guest",
        connection_id="c1",
        capabilities=["join", "monitor"],
        client_seq=1,
    )
    pid = echo["participant_id"]
    lease = echo["lease"]
    release_connection(pid, "c1", hub_key=record_hub_key(ws.project))
    svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name="Ava",
        participant_id=pid,
        lease=lease,
        client_id="rec-guest-2",
        connection_id="c2",
        capabilities=["join", "monitor"],
        client_seq=1,
    )
    svc.disconnect(pid, connection_id="c1")
    person = next(p for p in svc.snapshot()["participants"] if p["participant_id"] == pid)
    assert person["connected"] is True


def test_rejoin_after_leave_same_client_seq_reconnects(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws?client_id=viewer-same") as sock:
        _join(sock, name="Ava", seq=1)
        echo = _drain_until(sock, lambda m: m.get("type") == "Echo")
        pid, lease = echo["participant_id"], echo["lease"]
        sock.send_json(
            {
                "type": "Record",
                "command_type": "Consent",
                "payload": {"accepted": True},
                "client_seq": 2,
            }
        )
        _drain_until(sock, lambda m: m.get("command_type") == "Consent")
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    left = next(p for p in svc.snapshot()["participants"] if p["participant_id"] == pid)
    assert left["connected"] is False
    with client.websocket_connect(f"/api/rec/{token}/ws?client_id=viewer-same") as sock:
        _join(sock, name="Ava", participant_id=pid, lease=lease, seq=1)
        echo = _drain_until(sock, lambda m: m.get("type") == "Echo")
        assert echo["participant_id"] == pid
        snap = _drain_until(sock, lambda m: m.get("type") == "Snapshot")
        person = next(p for p in snap["snapshot"]["participants"] if p["participant_id"] == pid)
        assert person["connected"] is True
        assert person["consented"] is None


@pytest.mark.usefixtures("raising_stop_tasks")
def test_record_ws_cleanup_runs_when_stop_tasks_raises(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    import contextlib

    from podcast_mcp.services.remote_mcp.limits import (
        get_host_limiters,
        reset_host_limiters_for_tests,
    )

    monkeypatch.setenv("PODCAST_GUEST_WS_CONCURRENT", "1")
    reset_host_limiters_for_tests()
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with contextlib.suppress(RuntimeError):
        with client.websocket_connect(f"/api/rec/{token}/ws?name=Ava") as sock:
            _join(sock, name="Ava")
            echo = _drain_until(sock, lambda m: m.get("type") == "Echo")
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    ava = next(
        p for p in svc.snapshot()["participants"] if p["participant_id"] == echo["participant_id"]
    )
    assert ava["connected"] is False
    lim = get_host_limiters()
    assert lim.guest_ws_concurrent.try_enter(token).allowed  # slot was released
    lim.guest_ws_concurrent.exit(token)


def test_record_http_state_and_command_errors(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, _created, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    ok = client.get("/api/record/state", params={"path": str(ws.path)})
    assert ok.status_code == 200
    assert ok.json()["state"] == "lobby"
    from podcast_mcp.services.record.commands import RecordAuthzError

    def _forbid(self, command_type, payload=None):
        raise RecordAuthzError("host only")

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.record_host.RecordControlService.submit_host",
        _forbid,
    )
    forbidden = client.post(
        "/api/record/command",
        json={"path": str(ws.path), "command_type": "Start", "payload": {}},
    )
    assert forbidden.status_code == 403


def test_guest_ws_join_first_malformed_heartbeat_and_rejoin(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws") as sock:
        sock.send_json({"type": "Presence"})
        err = _drain_until(sock, lambda m: m.get("code") == "join_first")
        assert err["type"] == "Error"
        sock.send_json(
            {
                "type": "Record",
                "command_type": "Consent",
                "payload": {"accepted": True},
                "client_seq": 1,
            }
        )
        err = _drain_until(sock, lambda m: m.get("code") == "join_first")
        assert err["plane"] == "record"
        sock.send_text("not-json{")
        _join(sock, name="Ava")
        echo = _drain_until(sock, lambda m: m.get("type") == "Echo")
        pid, lease = echo["participant_id"], echo["lease"]
        sock.send_json(
            {
                "type": "Record",
                "command_type": "Heartbeat",
                "payload": {},
                "client_seq": 2,
            }
        )
        beat = _drain_until(sock, lambda m: m.get("command_type") == "Heartbeat")
        assert beat["type"] == "Echo"
    with client.websocket_connect(f"/api/rec/{token}/ws") as sock:
        _join(sock, name="Ava", participant_id=pid, lease=lease)
        echo = _drain_until(sock, lambda m: m.get("type") == "Echo")
        assert echo["participant_id"] == pid
        sock.send_json(
            {
                "type": "Record",
                "command_type": "UpdateName",
                "payload": {"display_name": "   "},
                "client_seq": 2,
            }
        )
        bad = _drain_until(sock, lambda m: m.get("type") == "Error")
        assert bad["code"] == "invalid_state"


def test_guest_ws_invalid_lease_and_room_full(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws") as sock:
        _join(sock, name="Ava", participant_id="p_nope", lease="not-a-lease")
        err = _drain_until(sock, lambda m: m.get("type") == "Error")
        assert err["code"] == "invalid_lease"
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    for i in range(3):
        svc.join(
            token=token,
            role="guest",
            display_name=f"G{i}",
            client_id=f"fill-{i}",
            connection_id=f"fill-conn-{i}",
            capabilities=["join", "monitor"],
        )
    with client.websocket_connect(f"/api/rec/{token}/ws") as fifth:
        _join(fifth, name="G3")
        err = _drain_until(fifth, lambda m: m.get("type") == "Error")
        assert err["code"] == "room_full"
    echo, _snap = svc.join(
        token="",
        role="host",
        display_name="Host",
        client_id="host-after-guests",
        connection_id="host-conn",
        capabilities=["join", "monitor"],
    )
    assert echo["participant_id"] == "p_host"
    people = svc.snapshot()["participants"]
    assert any(p["participant_id"] == "p_host" and p["connected"] for p in people)


def test_record_ws_reject_paths(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    from podcast_mcp.gui.routes import guest_ws_common as gwc
    from podcast_mcp.gui.routes import record_share as rec_mod
    from podcast_mcp.services.collaboration.share import lookup_share
    from podcast_mcp.services.collaboration.share_registry import SHARE_KIND_RECORD

    row = lookup_share(token, kind=SHARE_KIND_RECORD)

    def _patch_lookup(fn):
        monkeypatch.setattr(rec_mod, "lookup_share", fn)
        monkeypatch.setattr(gwc, "lookup_share", fn)

    def _no_monitor(tok, kind=None):
        out = dict(row)
        out["capabilities"] = ["join"]
        return out

    _patch_lookup(_no_monitor)
    try:
        with client.websocket_connect(f"/api/rec/{token}/ws") as sock:
            sock.receive_json()
            raise AssertionError("expected close")
    except Exception:
        pass
    _patch_lookup(lambda tok, kind=None: {**row, "role": "host"})
    try:
        with client.websocket_connect(f"/api/rec/{token}/ws") as sock:
            sock.receive_json()
            raise AssertionError("expected close")
    except Exception:
        pass
    _patch_lookup(lambda tok, kind=None: {**row, "session_id": ""})
    try:
        with client.websocket_connect(f"/api/rec/{token}/ws") as sock:
            sock.receive_json()
            raise AssertionError("expected close")
    except Exception:
        pass
    _patch_lookup(lambda tok, kind=None: row)

    def _gone(*_a, **_k):
        raise FileNotFoundError("gone")

    monkeypatch.setattr(rec_mod, "open_share_workspace", _gone)
    try:
        with client.websocket_connect(f"/api/rec/{token}/ws") as sock:
            sock.receive_json()
            raise AssertionError("expected close")
    except Exception:
        pass
    from podcast_mcp.gui.routes.record_share import _record_still_valid

    _patch_lookup(lookup_share)
    assert _record_still_valid(token) is True
    ShareService(ws).revoke_room(room["session_id"])
    assert _record_still_valid(token) is False
    assert _record_still_valid("missing-token") is False


def test_record_ws_rate_limit_skips_frames(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from podcast_mcp.gui.routes import guest_ws_common as gwc
    from podcast_mcp.gui.routes import record_share as rec_mod

    class _Dec:
        def __init__(self, allowed: bool) -> None:
            self.allowed = allowed

    class _Gate:
        def try_enter(self, _token: str) -> _Dec:
            return _Dec(False)

        def exit(self, _token: str) -> None:
            return None

    class _Lim:
        def allow(self, _key: str) -> _Dec:
            return _Dec(False)

    class _Limiters:
        guest_ws_concurrent = _Gate()
        guest_ws_record = _Lim()
        guest_ws_record_token = _Lim()

    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    monkeypatch.setattr(rec_mod, "host_rate_limit_enabled", lambda: True)
    monkeypatch.setattr(rec_mod, "get_host_limiters", lambda: _Limiters())
    monkeypatch.setattr(gwc, "host_rate_limit_enabled", lambda: True)
    monkeypatch.setattr(gwc, "get_host_limiters", lambda: _Limiters())
    try:
        with client.websocket_connect(f"/api/rec/{token}/ws") as sock:
            sock.receive_json()
            raise AssertionError("expected 4429 close")
    except Exception:
        pass

    class _AllowThenDeny:
        def __init__(self) -> None:
            self.n = 0

        def allow(self, _key: str) -> _Dec:
            self.n += 1
            return _Dec(self.n > 1)

    class _Always:
        def allow(self, _key: str) -> _Dec:
            return _Dec(True)

    class _Open:
        def try_enter(self, _token: str) -> _Dec:
            return _Dec(True)

        def exit(self, _token: str) -> None:
            return None

    class _SkipFirst:
        guest_ws_concurrent = _Open()
        guest_ws_record = _AllowThenDeny()
        guest_ws_record_token = _Always()

    monkeypatch.setattr(rec_mod, "get_host_limiters", lambda: _SkipFirst())
    monkeypatch.setattr(gwc, "get_host_limiters", lambda: _SkipFirst())
    with client.websocket_connect(f"/api/rec/{token}/ws") as sock:
        _join(sock, name="Skip")
        _join(sock, name="Ava")
        echo = _drain_until(sock, lambda m: m.get("type") == "Echo")
        assert echo["participant_id"]


def test_record_service_helpers(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    import time

    from podcast_mcp.services.record.service import (
        claim_connection,
        filter_record_event_for_guest,
        record_hub_key,
        release_connection,
    )

    ws, room, _client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    hub = record_hub_key(ws.project)
    with pytest.raises(ValueError, match="join_first"):
        apply_record_ws_message(
            svc,
            {"type": "Nope"},
            client_id="c",
            role="guest",
            participant_id="p",
            seq=1,
        )
    svc.disconnect("p_missing", connection_id="c-missing")
    stripped = filter_record_event_for_guest(
        {"lease": "secret", "keep": 1, "nested": [{"lease_hash": "h"}, "ok"]},
        participant_id="p",
        role="guest",
    )
    assert stripped == {"keep": 1, "nested": [{}, "ok"]}
    event = {"type": "Applied", "snapshot": {"state": "lobby", "target": {"kind": "end"}}}
    for role in ("host", "producer"):
        kept = filter_record_event_for_guest(event, participant_id="p", role=role)
        assert kept is not None and kept["snapshot"]["target"] == {"kind": "end"}
    hidden = filter_record_event_for_guest(event, participant_id="p", role="guest")
    assert hidden is not None and "target" not in hidden["snapshot"]
    claim_connection("p_grace", "c1", hub_key=hub)
    now = time.monotonic()
    monkeypatch.setattr(
        "podcast_mcp.services.record.service.time.monotonic",
        lambda: now + 20,
    )
    claim_connection("p_grace", "c2", hub_key=hub)
    release_connection("p_grace", "c2", hub_key=hub)
    with pytest.raises(RecordAuthzError, match="invalid_lease"):
        svc.join(
            token=room["guest"]["token"],
            role="guest",
            display_name="Ava",
            participant_id="p_nope",
            lease="bad-lease",
            client_id="c",
            connection_id="cx",
            capabilities=["join", "monitor"],
        )


def test_rejected_join_distinguishes_expired_lease_from_removed_participant(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws") as first:
        _join(first, name="Ava")
        echo = _drain_until(first, lambda m: m.get("type") == "Echo")
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    svc._participants.revoke(echo["participant_id"], session_id=room["session_id"])
    with client.websocket_connect(f"/api/rec/{token}/ws") as expired:
        _join(expired, name="Ava", participant_id=echo["participant_id"], lease=echo["lease"])
        err = _drain_until(expired, lambda m: m.get("type") == "Error")
        assert err["code"] == "invalid_lease"
        _join(expired, name="Ava")
        fresh = _drain_until(expired, lambda m: m.get("type") == "Echo")
        assert fresh["participant_id"] != echo["participant_id"]
    svc.submit(
        RecordCommand.parse(
            command_type="RemoveParticipant",
            payload={"participant_id": echo["participant_id"]},
            client_id="host",
            role="host",
            participant_id="host",
            client_seq=1,
        )
    )
    with client.websocket_connect(f"/api/rec/{token}/ws") as removed:
        _join(removed, name="Ava", participant_id=echo["participant_id"], lease=echo["lease"])
        err = _drain_until(removed, lambda m: m.get("type") == "Error")
        assert err["code"] == "participant_removed"


def test_join_lease_validation_and_removal_share_one_room_decision(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    ws, room, _client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    token = room["guest"]["token"]
    echo, _snap = svc.join(
        token=token,
        role="guest",
        display_name="Ava",
        client_id="first",
        connection_id="first-socket",
        capabilities=["join", "monitor"],
        client_seq=1,
    )
    svc.disconnect(echo["participant_id"], connection_id="first-socket")
    entered = Event()
    release = Event()
    removal_started = Event()
    real_verify = svc.verify_lease

    def paused_verify(participant_id, lease, *, token):
        entered.set()
        assert release.wait(3)
        return real_verify(participant_id, lease, token=token)

    monkeypatch.setattr(svc, "verify_lease", paused_verify)

    def rejoin():
        return svc.join(
            token=token,
            role="guest",
            display_name="Ava",
            participant_id=echo["participant_id"],
            lease=echo["lease"],
            client_id="second",
            connection_id="second-socket",
            capabilities=["join", "monitor"],
            client_seq=1,
        )

    def remove():
        removal_started.set()
        return RecordControlService(ws).submit_host(
            "RemoveParticipant", payload={"participant_id": echo["participant_id"]}
        )

    with ThreadPoolExecutor(max_workers=2, thread_name_prefix="join-review") as pool:
        join_future = pool.submit(rejoin)
        assert entered.wait(3)
        remove_future = pool.submit(remove)
        assert removal_started.wait(3)
        assert not remove_future.done()
        release.set()
        rejoined, _snap = join_future.result(timeout=3)
        assert rejoined["participant_id"] == echo["participant_id"]
        remove_future.result(timeout=3)
    with pytest.raises(RecordAuthzError, match="participant_removed"):
        rejoin()


@pytest.mark.asyncio
async def test_guest_ws_guard_recheck_and_malformed():
    from podcast_mcp.gui.routes.guest_ws_common import GuestWsGuard, guest_ws_reject

    class _Ws:
        def __init__(self) -> None:
            self.closed: list[tuple[int, str]] = []
            self.sent: list[dict] = []

        async def accept(self) -> None:
            return None

        async def close(self, code: int, reason: str) -> None:
            self.closed.append((code, reason))

        async def send_json(self, payload: dict) -> None:
            self.sent.append(payload)

    ws = _Ws()
    await guest_ws_reject(ws, 4403, "invalid or revoked share token")
    assert ws.closed[0][0] == 4403
    guard = GuestWsGuard(ws, lambda: False, interval=0.01, on_frame=0.0, malformed_limit=2)
    assert await guard.share_ok_on_frame() is False
    assert guard.note_malformed() is False
    assert guard.note_malformed() is False
    assert guard.note_malformed() is True
    await guard.send_json({"ok": True})
    await guard.recheck_loop()
    assert any(code == 4403 for code, _reason in ws.closed)
    assert (4403, "share revoked or expired") in ws.closed
    assert guard.closed is True
    await guard.close(4403, "already closed")
    await guard.send_json({"ignored": True})
    assert len(ws.closed) == 2
    assert ws.sent == [{"ok": True}]

    allowed = True
    gated = GuestWsGuard(ws, lambda: True, send_gate=lambda: allowed)
    await gated.send_json({"before": True})
    allowed = False
    await gated.send_json({"after": True})
    assert gated.closed is True
    assert ws.sent == [{"ok": True}, {"before": True}]
    assert ws.closed[-1][0] == 4403


def test_host_refcount_touch_stale_connection_and_sid_cache(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.services.record.commands import RecordCommand
    from podcast_mcp.services.record.reducer import RecordStateError
    from podcast_mcp.services.record.service import (
        claim_connection,
        connection_holds,
        record_hub_key,
        release_connection,
        touch_connection,
    )
    from podcast_mcp.services.record.state import HOST_PARTICIPANT_ID
    from podcast_mcp.services.session_sync.log import drop_cached_stores_for_tests

    ws, room, _client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    hub = record_hub_key(ws.project)
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    first = RecordSessionService.active_session_id(ws.project)
    again = RecordSessionService.active_session_id(ws.project)
    assert first == again == room["session_id"]

    echo, _snap = svc.join(
        token="",
        role="host",
        display_name="Host",
        client_id="host-ref",
        connection_id="h1",
        capabilities=["join", "monitor"],
    )
    assert echo["participant_id"] == HOST_PARTICIPANT_ID
    claim_connection(HOST_PARTICIPANT_ID, "h2", hub_key=hub)
    touch_connection(HOST_PARTICIPANT_ID, "h1", hub_key=hub)
    touch_connection(HOST_PARTICIPANT_ID, "missing", hub_key=hub)
    assert release_connection(HOST_PARTICIPANT_ID, "h1", hub_key=hub) is False
    assert connection_holds(hub, HOST_PARTICIPANT_ID, "h2")
    leave = RecordCommand.parse(
        command_type="Leave",
        payload={},
        client_id="leave-while-live",
        role="host",
        participant_id=HOST_PARTICIPANT_ID,
        client_seq=50,
    )
    still = svc.submit(leave, capabilities=["join", "monitor"], connection_id="h1")
    host = next(p for p in still["participants"] if p["participant_id"] == HOST_PARTICIPANT_ID)
    assert host["connected"] is True
    svc.disconnect(HOST_PARTICIPANT_ID, connection_id="h1")
    host = next(
        p for p in svc.snapshot()["participants"] if p["participant_id"] == HOST_PARTICIPANT_ID
    )
    assert host["connected"] is True
    svc.disconnect(HOST_PARTICIPANT_ID, connection_id="h2")
    host = next(
        p for p in svc.snapshot()["participants"] if p["participant_id"] == HOST_PARTICIPANT_ID
    )
    assert host["connected"] is False
    svc.disconnect(HOST_PARTICIPANT_ID)
    assert release_connection(HOST_PARTICIPANT_ID, "ghost", hub_key="no-hub") is True

    guest, _ = svc.join(
        token=room["guest"]["token"],
        role="guest",
        display_name="Ava",
        client_id="g-ref",
        connection_id="g1",
        capabilities=["join", "monitor"],
    )
    pid = guest["participant_id"]
    touch_connection(pid, "g1", hub_key=hub)
    touch_connection(pid, "nope", hub_key=hub)
    assert release_connection(pid, "other", hub_key=hub) is False
    with pytest.raises(RecordStateError, match="stale_connection"):
        apply_record_ws_message(
            svc,
            {"type": "Record", "command_type": "Heartbeat", "payload": {}, "client_seq": 2},
            client_id="g-ref",
            role="guest",
            participant_id=pid,
            seq=2,
            capabilities=["join", "monitor"],
            connection_id="other",
        )
    echo, _seq = apply_record_ws_message(
        svc,
        {"type": "Record", "command_type": "Heartbeat", "payload": {}, "client_seq": 2},
        client_id="g-ref",
        role="guest",
        participant_id=pid,
        seq=2,
        capabilities=["join", "monitor"],
        connection_id="g1",
    )
    assert echo["command_type"] == "Heartbeat"
    echo2, _seq = apply_record_ws_message(
        svc,
        {"type": "Record", "command_type": "Heartbeat", "payload": {}, "client_seq": 2},
        client_id="g-ref",
        role="guest",
        participant_id=pid,
        seq=2,
        capabilities=["join", "monitor"],
        connection_id="g1",
    )
    assert echo2["command_type"] == "Heartbeat"
    svc.disconnect(pid, connection_id="g1")
    svc.disconnect(pid, connection_id="g1")
    drop_cached_stores_for_tests(kind="sync", variant="record_")


def test_share_common_token_and_manifest(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from fastapi import HTTPException

    from podcast_mcp.gui.routes.share_common import (
        check_share_token,
        rate_limit_share,
        share_features_manifest,
    )
    from podcast_mcp.services.collaboration.share import ShareService
    from podcast_mcp.services.collaboration.share_registry import SHARE_KIND_RECORD
    from podcast_mcp.util.coded_error import AccessDeniedError, UnknownShareError
    from podcast_mcp.util.rate_limit import RateLimitDecision

    _isolate()
    ws = _seed_premix(minimal_project, sample_wav)
    room = ShareService(ws).create_record_room()
    token = room["guest"]["token"]

    class _App:
        state = type("S", (), {})()

    class _Req:
        app = _App()

    manifest = share_features_manifest(_Req())
    assert "features" in manifest
    with pytest.raises(UnknownShareError) as missing:
        check_share_token("not-a-token")
    assert missing.value.code == "share_not_found"
    row = check_share_token(token, kind=SHARE_KIND_RECORD)
    assert row.get("session_id") == room["session_id"]
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.share_common.authorize_share_token",
        lambda **_k: type("D", (), {"allowed": False, "reason": "nope"})(),
    )
    with pytest.raises(AccessDeniedError) as denied:
        check_share_token(token, kind=SHARE_KIND_RECORD)
    assert str(denied.value) == "nope"
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.share_common.check_host_bucket",
        lambda *_a, **_k: RateLimitDecision(allowed=False, bucket="host_read", retry_after_sec=1.5),
    )
    with pytest.raises(HTTPException) as limited:
        rate_limit_share(token, "read")
    assert limited.value.status_code == 429


def test_host_ws_record_attach_error_and_fail_until(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from urllib.parse import quote

    ws, _created, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)

    attempts = []

    def boom(*_a, **_k):
        attempts.append(True)
        raise RecordStateError("boom")

    monkeypatch.setattr(
        "podcast_mcp.gui.routes.host.RecordSessionService.join",
        boom,
    )
    url = f"/api/host/ws?document_client_id=doc-test&path={quote(str(ws.path))}&client_id=host-fail&role=viewer&label=Host"
    with client.websocket_connect(url) as host:
        assert host.receive_json()["type"] == "Snapshot"
        err = _drain_until(host, lambda m: m.get("code") == "record_attach_failed")
        assert err["plane"] == "record"
        host.send_json({"type": "ViewerState", "snapshot": {"playhead_sec": 0}})
        msg = _drain_until(host, lambda m: m.get("type") == "Echo")
        assert msg["plane"] == "session"
        assert len(attempts) == 1


def test_host_ws_reattaches_when_record_session_changes(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from urllib.parse import quote

    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    orig = RecordSessionService.active_session_id
    seen = {"n": 0}

    def flip(project):
        seen["n"] += 1
        sid = orig(project)
        if seen["n"] >= 2 and sid:
            return f"{sid}-next"
        return sid

    monkeypatch.setattr(
        RecordSessionService,
        "active_session_id",
        staticmethod(flip),
    )
    url = f"/api/host/ws?document_client_id=doc-test&path={quote(str(ws.path))}&client_id=host-flip&role=viewer&label=Host"
    with client.websocket_connect(url) as host:
        _drain_until(host, lambda m: m.get("plane") == "record")
        host.send_json({"type": "Presence", "playhead_sec": 0, "client_seq": 2, "meta": {}})
        rec = _drain_until(
            host,
            lambda m: m.get("plane") == "record" and m.get("type") in {"Echo", "Snapshot"},
            n=40,
        )
        assert rec["plane"] == "record"
        assert room["session_id"]


def test_host_ws_teardown_survives_record_disconnect_error(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, removed_session_clients
):
    import contextlib
    from urllib.parse import quote

    from podcast_mcp.gui.routes import host as session_routes
    from podcast_mcp.gui.routes.guest_ws_common import WsTaskSet
    from podcast_mcp.services.record.service import record_hub_key
    from podcast_mcp.services.record.state import HOST_PARTICIPANT_ID
    from podcast_mcp.services.session_sync.hub import get_hub

    ws, _created, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    spawned = []

    class _SpyTaskSet(WsTaskSet):
        def spawn(self, coro):
            task = super().spawn(coro)
            spawned.append(task)
            return task

    monkeypatch.setattr(session_routes, "WsTaskSet", _SpyTaskSet)
    disconnects = []

    def _locked(self, participant_id, *, connection_id=None):
        disconnects.append(participant_id)
        raise RuntimeError("database is locked")

    monkeypatch.setattr(RecordSessionService, "disconnect", _locked)
    url = f"/api/host/ws?document_client_id=doc-test&path={quote(str(ws.path))}&client_id=host-lock&role=viewer&label=Host"
    with contextlib.suppress(RuntimeError):
        with client.websocket_connect(url) as host:
            assert host.receive_json()["type"] == "Snapshot"
            _drain_until(host, lambda m: m.get("plane") == "record")
    hub = get_hub()
    assert disconnects == [HOST_PARTICIPANT_ID]
    # remove_client runs in the inner finally even though disconnect raised.
    assert removed_session_clients == ["host-lock"]
    assert len(spawned) >= 2  # session hub pump + record pump
    assert all(task.done() for task in spawned)
    assert hub.listener_count(str(ws.project.workspace_path())) == 0
    assert hub.listener_count(record_hub_key(ws.project)) == 0


def _remove(client, ws, pid: str) -> None:
    response = client.post(
        "/api/record/command",
        json={
            "path": str(ws.path),
            "command_type": "RemoveParticipant",
            "payload": {"participant_id": pid},
        },
    )
    assert response.status_code == 200, response.text


def _join_two(client, token: str):
    """Join Ava and Bea on one token; return (ava_echo, bea_echo)."""
    with client.websocket_connect(f"/api/rec/{token}/ws") as ava:
        _join(ava, name="Ava")
        a = _drain_until(ava, lambda m: m.get("type") == "Echo")
    with client.websocket_connect(f"/api/rec/{token}/ws") as bea:
        _join(bea, name="Bea")
        b = _drain_until(bea, lambda m: m.get("type") == "Echo")
    return a, b


def test_removed_invite_refuses_new_identity_while_other_guest_continues(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws") as ava:
        _join(ava, name="Ava")
        a = _drain_until(ava, lambda m: m.get("type") == "Echo")
        with client.websocket_connect(f"/api/rec/{token}/ws") as bea:
            _join(bea, name="Bea")
            b = _drain_until(bea, lambda m: m.get("type") == "Echo")
            _remove(client, ws, a["participant_id"])
            with client.websocket_connect(f"/api/rec/{token}/ws") as fresh:
                _join(fresh, name="Cy")
                err = _drain_until(fresh, lambda m: m.get("type") == "Error")
                assert err["code"] == "invite_closed"
            bea.send_json(
                {"type": "Record", "command_type": "Heartbeat", "payload": {}, "client_seq": 2}
            )
            _drain_until(bea, lambda m: m.get("command_type") == "Heartbeat")
    with client.websocket_connect(f"/api/rec/{token}/ws") as again:
        _join(again, name="Bea", participant_id=b["participant_id"], lease=b["lease"])
        echo = _drain_until(again, lambda m: m.get("type") == "Echo")
        assert echo["participant_id"] == b["participant_id"]


def test_removed_invite_omitting_lease_is_refused_over_relay(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    a, _b = _join_two(client, token)
    _remove(client, ws, a["participant_id"])
    relay = {"x-sharecut-relayed": "1"}
    with client.websocket_connect(f"/api/rec/{token}/ws", headers=relay) as fresh:
        _join(fresh, name="Cy")
        err = _drain_until(fresh, lambda m: m.get("type") == "Error")
        assert err["code"] == "invite_closed"
    with client.websocket_connect(f"/api/rec/{token}/ws", headers=relay) as old:
        _join(old, name="Ava", participant_id=a["participant_id"], lease=a["lease"])
        err = _drain_until(old, lambda m: m.get("type") == "Error")
        assert err["code"] == "participant_removed"


def test_invite_closure_survives_runtime_reset(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    a, b = _join_two(client, token)
    _remove(client, ws, a["participant_id"])
    reset_record_runtime_for_tests()
    client = TestClient(create_app())
    with client.websocket_connect(f"/api/rec/{token}/ws") as fresh:
        _join(fresh, name="Cy")
        err = _drain_until(fresh, lambda m: m.get("type") == "Error")
        assert err["code"] == "invite_closed"
    with client.websocket_connect(f"/api/rec/{token}/ws") as again:
        _join(again, name="Bea", participant_id=b["participant_id"], lease=b["lease"])
        echo = _drain_until(again, lambda m: m.get("type") == "Echo")
        assert echo["participant_id"] == b["participant_id"]


def test_invite_closure_is_scoped_to_the_removed_participants_token(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    a, _b = _join_two(client, token)
    _remove(client, ws, a["participant_id"])
    new = ShareService(ws).create_record_token(role="guest", session_id=room["session_id"])
    for tok in (new["token"], room["producer"]["token"]):
        with client.websocket_connect(f"/api/rec/{tok}/ws") as sock:
            _join(sock, name="Dee")
            echo = _drain_until(sock, lambda m: m.get("type") == "Echo")
            assert echo["participant_id"]


def test_expired_lease_on_closed_invite_cannot_mint(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    a, b = _join_two(client, token)
    _remove(client, ws, a["participant_id"])
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    svc._participants.revoke(b["participant_id"], session_id=room["session_id"])
    with client.websocket_connect(f"/api/rec/{token}/ws") as sock:
        _join(sock, name="Bea", participant_id=b["participant_id"], lease=b["lease"])
        err = _drain_until(sock, lambda m: m.get("type") == "Error")
        assert err["code"] == "invalid_lease"
        _join(sock, name="Bea", seq=2)
        err = _drain_until(sock, lambda m: m.get("type") == "Error")
        assert err["code"] == "invite_closed"


def test_unaffected_guest_keeper_status_after_invite_closed(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    a, b = _join_two(client, token)
    _remove(client, ws, a["participant_id"])
    ok = client.get(
        f"/api/rec/{token}/upload",
        headers={"X-Record-Participant": b["participant_id"], "X-Record-Lease": b["lease"]},
    )
    assert ok.status_code == 200, ok.text
    gone = client.get(
        f"/api/rec/{token}/upload",
        headers={"X-Record-Participant": a["participant_id"], "X-Record-Lease": a["lease"]},
    )
    assert gone.status_code == 403


def test_client_visible_authz_codes_cover_join_refusals():
    assert {"participant_removed", "invalid_lease", "invite_closed"} == CLIENT_VISIBLE_AUTHZ_CODES


def test_invite_closed_closes_the_socket_with_4403(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    a, _b = _join_two(client, token)
    _remove(client, ws, a["participant_id"])
    with client.websocket_connect(f"/api/rec/{token}/ws") as fresh:
        _join(fresh, name="Cy")
        err = _drain_until(fresh, lambda m: m.get("type") == "Error")
        assert err["code"] == "invite_closed"
        with pytest.raises(WebSocketDisconnect) as closed:
            fresh.receive_json()
        assert closed.value.code == 4403


def test_join_mint_raises_invite_closed(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    a, _b = _join_two(client, token)
    _remove(client, ws, a["participant_id"])
    svc = RecordSessionService(ws.project, session_id=room["session_id"])
    assert svc.invite_closed(token) is True
    assert svc.invite_closed(room["producer"]["token"]) is False
    with pytest.raises(RecordAuthzError, match="invite_closed"):
        svc.join(
            token=token,
            role="guest",
            display_name="Cy",
            client_id="c1",
            connection_id="conn1",
        )


def test_host_mux_record_io_is_off_loop_and_all_frames_use_guard(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    import asyncio
    from contextvars import ContextVar
    from urllib.parse import quote

    from fastapi import WebSocket

    from podcast_mcp.gui.routes import host as host_route
    from podcast_mcp.gui.routes.guest_ws_common import GuestWsGuard

    ws, _room_info, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    calls = []
    for name in ("join", "disconnect"):
        original = getattr(RecordSessionService, name)

        def spy(self, *args, _name=name, _original=original, **kwargs):
            try:
                asyncio.get_running_loop()
                on_loop = True
            except RuntimeError:
                on_loop = False
            calls.append((_name, on_loop))
            return _original(self, *args, **kwargs)

        monkeypatch.setattr(RecordSessionService, name, spy)
    route = host_route.route_record_ws_message

    def dispatch(*args, **kwargs):
        with pytest.raises(RuntimeError, match="no running event loop"):
            asyncio.get_running_loop()
        calls.append(("dispatch", False))
        return route(*args, **kwargs)

    monkeypatch.setattr(host_route, "route_record_ws_message", dispatch)
    guarded = ContextVar("guarded", default=False)
    original_guard_send = GuestWsGuard.send_json
    original_send = WebSocket.send_json
    frames = []

    async def through_guard(self, payload):
        mark = guarded.set(True)
        try:
            await original_guard_send(self, payload)
        finally:
            guarded.reset(mark)

    async def checked_send(self, payload, *args, **kwargs):
        assert guarded.get()
        assert payload["plane"] in {"session", "document", "record"}
        frames.append(payload)
        await original_send(self, payload, *args, **kwargs)

    monkeypatch.setattr(GuestWsGuard, "send_json", through_guard)
    monkeypatch.setattr(WebSocket, "send_json", checked_send)
    url = f"/api/host/ws?path={quote(str(ws.path))}&client_id=owner&document_client_id=doc-owner"
    with client.websocket_connect(url) as socket:
        _drain_until(
            socket, lambda frame: frame.get("plane") == "record" and frame.get("type") == "Snapshot"
        )
        socket.send_json(
            {"type": "Record", "command_type": "Heartbeat", "payload": {}, "client_seq": 10}
        )
        echo = _drain_until(
            socket,
            lambda frame: frame.get("command_type") == "Heartbeat" and frame.get("type") == "Echo",
        )
        assert echo["client_id"] == "owner"
    assert {name for name, _ in calls} == {"join", "dispatch", "disconnect"}
    assert not any(on_loop for _, on_loop in calls)
    record_frames = [frame for frame in frames if frame["plane"] == "record"]
    assert [frame["type"] for frame in record_frames[:2]] == ["Echo", "Snapshot"]


@pytest.mark.parametrize("stage", ["constructor", "snapshot"])
def test_guest_record_setup_crash_is_private_and_releases_admission(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, caplog, stage
):
    from podcast_mcp.gui.routes import record_share
    from podcast_mcp.services.record.state import RecordSnapshot
    from podcast_mcp.services.remote_mcp.limits import (
        get_host_limiters,
        reset_host_limiters_for_tests,
    )

    monkeypatch.setenv("PODCAST_GUEST_WS_CONCURRENT", "1")
    reset_host_limiters_for_tests()
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    diagnostic = "secret phrase /private/host/a"

    def fail(*_args, **_kwargs):
        if stage == "snapshot":
            return RecordSnapshot.model_validate({"state": diagnostic})
        raise ValueError(diagnostic)

    if stage == "constructor":
        monkeypatch.setattr(record_share, "RecordSessionService", fail)
    else:
        monkeypatch.setattr(RecordSessionService, "snapshot", fail)
    with pytest.raises(WebSocketDisconnect) as failure:
        with client.websocket_connect(f"/api/rec/{token}/ws") as socket:
            if stage == "snapshot":
                _join(socket, name="Ava")
            socket.receive_json()
    assert failure.value.code == 1011
    assert failure.value.reason == "internal error"
    assert diagnostic in str([r.exc_info[1] for r in caplog.records if r.exc_info])
    limiter = get_host_limiters().guest_ws_concurrent
    assert limiter.try_enter(token).allowed
    limiter.exit(token)


@pytest.mark.parametrize("error_type", [ValueError, PermissionError, RuntimeError])
def test_guest_record_command_crash_closes_safely_and_disconnects(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, caplog, error_type
):
    from podcast_mcp.gui.routes import record_share
    from podcast_mcp.services.record import record_hub_key
    from podcast_mcp.services.session_sync import get_hub

    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    diagnostic = "private secret phrase /private/host/record.sqlite"

    def fail(*_args, **_kwargs):
        raise error_type(diagnostic)

    monkeypatch.setattr(record_share, "route_record_ws_message", fail)
    with pytest.raises(WebSocketDisconnect) as failure:
        with client.websocket_connect(f"/api/rec/{token}/ws") as socket:
            _join(socket, name="Ava")
            echo = _drain_until(socket, lambda msg: msg.get("type") == "Echo")
            _drain_until(socket, lambda msg: msg.get("type") == "Snapshot")
            socket.send_json({"type": "Record", "command_type": "Heartbeat", "client_seq": 2})
            for _ in range(20):
                frame = socket.receive_json()
                assert diagnostic not in str(frame)
    assert failure.value.code == 1011
    assert failure.value.reason == "internal error"
    assert diagnostic in str([r.exc_info[1] for r in caplog.records if r.exc_info])
    people = RecordSessionService(ws.project, session_id=room["session_id"]).snapshot()[
        "participants"
    ]
    assert (
        next(p for p in people if p["participant_id"] == echo["participant_id"])["connected"]
        is False
    )
    assert get_hub().listener_count(record_hub_key(ws.project)) == 0


def test_guest_record_state_refusal_redacts_paths_and_keeps_socket_usable(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.gui.routes import record_share

    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    original = record_share.route_record_ws_message
    refuse = True

    def dispatch(*args, **kwargs):
        nonlocal refuse
        if refuse:
            refuse = False
            raise RecordStateError("not ready /private/host/project.json")
        return original(*args, **kwargs)

    monkeypatch.setattr(record_share, "route_record_ws_message", dispatch)
    with client.websocket_connect(f"/api/rec/{room['guest']['token']}/ws") as socket:
        _join(socket, name="Ava")
        _drain_until(socket, lambda msg: msg.get("type") == "Snapshot")
        command = {"type": "Record", "command_type": "Heartbeat", "client_seq": 2}
        socket.send_json(command)
        frame = _drain_until(socket, lambda msg: msg.get("type") == "Error")
        assert frame == {
            "plane": "record",
            "type": "Error",
            "code": "invalid_state",
            "detail": GENERIC_GUEST_MESSAGE,
            "error_code": "record_state_refused",
        }
        socket.send_json(command)
        assert (
            _drain_until(socket, lambda msg: msg.get("command_type") == "Heartbeat")["type"]
            == "Echo"
        )


def test_guest_record_input_refusal_hides_payload_and_keeps_socket_usable(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    with client.websocket_connect(f"/api/rec/{room['guest']['token']}/ws") as socket:
        _join(socket, name="Ava")
        _drain_until(socket, lambda msg: msg.get("type") == "Snapshot")
        socket.send_json(
            {
                "type": "Record",
                "command_type": "Heartbeat",
                "client_seq": "private secret phrase /private/host/project.json",
            }
        )
        frame = _drain_until(socket, lambda msg: msg.get("type") == "Error")
        assert frame == {
            "plane": "record",
            "type": "Error",
            "code": "invalid_state",
            "detail": GENERIC_GUEST_MESSAGE,
            "error_code": "invalid_record_request",
        }
        socket.send_json({"type": "Record", "command_type": "Heartbeat", "client_seq": 2})
        assert (
            _drain_until(socket, lambda msg: msg.get("command_type") == "Heartbeat")["type"]
            == "Echo"
        )


@pytest.mark.parametrize("busy_type", ["sqlite", "timeout"])
def test_guest_record_busy_command_keeps_socket_usable(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, busy_type
):
    import sqlite3

    from filelock import Timeout

    from podcast_mcp.gui.routes import record_share

    _ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    original = record_share.route_record_ws_message
    refuse = True

    def dispatch(*args, **kwargs):
        nonlocal refuse
        if refuse:
            refuse = False
            raise (
                sqlite3.OperationalError("database is locked")
                if busy_type == "sqlite"
                else Timeout("/private/host/record.lock")
            )
        return original(*args, **kwargs)

    monkeypatch.setattr(record_share, "route_record_ws_message", dispatch)
    with client.websocket_connect(f"/api/rec/{room['guest']['token']}/ws") as socket:
        _join(socket, name="Ava")
        _drain_until(socket, lambda msg: msg.get("type") == "Snapshot")
        command = {"type": "Record", "command_type": "Heartbeat", "client_seq": 2}
        socket.send_json(command)
        frame = _drain_until(socket, lambda msg: msg.get("type") == "Error")
        assert frame == {
            "plane": "record",
            "type": "Error",
            "code": "invalid_state",
            "detail": "This project is busy; try again.",
            "error_code": "project_busy",
        }
        socket.send_json(command)
        assert (
            _drain_until(socket, lambda msg: msg.get("command_type") == "Heartbeat")["type"]
            == "Echo"
        )


def test_open_old_guest_socket_closes_after_remint(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.gui.routes import guest_ws_common

    monkeypatch.setattr(guest_ws_common, "GUEST_SHARE_RECHECK_S", 0.2)
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    token = room["guest"]["token"]
    with client.websocket_connect(f"/api/rec/{token}/ws") as sock:
        _join(sock, name="Ava")
        _drain_until(sock, lambda m: m.get("type") == "Echo")
        ShareService(ws).create_record_room()
        with pytest.raises(WebSocketDisconnect) as closed:
            for _ in range(200):
                sock.receive_json()
        assert closed.value.code == 4403


def test_room_tone_round_reaches_guests_and_guests_cannot_request_it(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    with client.websocket_connect(f"/api/rec/{room['guest']['token']}/ws") as guest:
        _join(guest, name="Ava")
        _drain_until(guest, lambda m: m.get("type") == "Snapshot")
        guest.send_json(
            {
                "type": "Record",
                "command_type": "RoomToneCountdown",
                "payload": {},
                "client_seq": 2,
            }
        )
        err = _drain_until(guest, lambda m: m.get("type") == "Error")
        assert err["code"] == "forbidden"
        posted = client.post(
            "/api/record/command",
            json={"path": str(ws.path), "command_type": "RoomToneCountdown", "payload": {}},
        )
        assert posted.status_code == 200, posted.text
        applied = _drain_until(
            guest,
            lambda m: (
                m.get("type") == "Applied"
                and (m.get("snapshot") or {}).get("room_tone") is not None
            ),
        )
        snap = applied["snapshot"]
        assert snap["room_tone"]["round"] == 1
        assert snap["room_tone"]["duration_ms"] == 60_000
        assert 0 < snap["countdown_left_ms"] <= 60_000
        assert snap["state"] == "lobby"


def test_target_is_host_only_and_hidden_from_guests(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, room, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)
    with client.websocket_connect(f"/api/rec/{room['guest']['token']}/ws") as guest:
        _join(guest, name="Ava")
        joined = _drain_until(guest, lambda m: m.get("type") == "Snapshot")
        assert "target" not in joined["snapshot"]
        guest.send_json(
            {
                "type": "Record",
                "command_type": "SetTarget",
                "payload": {"target": {"kind": "end"}},
                "client_seq": 2,
            }
        )
        err = _drain_until(guest, lambda m: m.get("type") == "Error")
        assert err["code"] == "forbidden"
        posted = client.post(
            "/api/record/command",
            json={
                "path": str(ws.path),
                "command_type": "SetTarget",
                "payload": {"target": {"kind": "end"}},
            },
        )
        assert posted.status_code == 200, posted.text
        assert posted.json()["target"] == {"kind": "end"}
        applied = _drain_until(
            guest,
            lambda m: m.get("type") == "Applied" and m["command"]["type"] == "SetTarget",
        )
        assert "target" not in applied["snapshot"]
        started = client.post(
            "/api/record/command",
            json={
                "path": str(ws.path),
                "command_type": "SetTarget",
                "payload": {"target": {"kind": "start"}},
            },
        )
        assert started.status_code == 200, started.text


def test_http_set_target_refusals_name_the_field(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws, _, client = _room(minimal_project, sample_wav, tmp_workspace, monkeypatch)

    def build(project):
        project.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE))
        project.clips.append(
            Clip(
                id="base",
                track_id="host",
                source_id="src-base",
                source_start=0.0,
                source_end=10.0,
                timeline_start=0.0,
            )
        )

    ws.mutate("seed", "seeded", build)
    cases = [
        ({"kind": "insert", "at_sec": -1}, "at_sec"),
        ({"kind": "replace", "from_sec": 1, "to_sec": 2, "track_ids": ["ghost"]}, "track_ids"),
        ({"kind": "replace", "from_sec": 8, "to_sec": 12, "track_ids": ["host"]}, "to_sec"),
        ({"kind": "replace", "from_sec": 5, "to_sec": 2, "track_ids": ["host"]}, "to_sec"),
    ]
    for target, field in cases:
        refused = client.post(
            "/api/record/command",
            json={"path": str(ws.path), "command_type": "SetTarget", "payload": {"target": target}},
        )
        assert refused.status_code == 400, refused.text
        assert field in refused.text
        assert "invalid record payload" not in refused.text
    for payload in ({}, {"target": None}, {"target": "end"}):
        refused = client.post(
            "/api/record/command",
            json={"path": str(ws.path), "command_type": "SetTarget", "payload": payload},
        )
        assert refused.status_code == 400, refused.text
        assert "target:" in refused.text
    far = {"kind": "insert", "at_sec": 500.0}
    ok = client.post(
        "/api/record/command",
        json={"path": str(ws.path), "command_type": "SetTarget", "payload": {"target": far}},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["target"] == far
