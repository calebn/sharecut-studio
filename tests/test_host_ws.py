from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from podcast_mcp.gui.routes import host
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project
from podcast_mcp.services.cross_process_sync import cross_process_bridge
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.service import document_hub_key
from podcast_mcp.services.session_sync.authz import AuthzDecision
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.services.session_sync.service import SessionSyncService
from sync_helpers import receive_host_plane


def _url(path, **extra):
    return "/api/host/ws?" + urlencode(
        {
            "path": str(path),
            "client_id": "presence-owner",
            "document_client_id": "document-owner",
            **extra,
        }
    )


def _hello(socket):
    first, second = socket.receive_json(), socket.receive_json()
    assert (first["plane"], first["type"]) == ("session", "Snapshot")
    assert (second["plane"], second["type"]) == ("document", "Snapshot")
    return first, second


@pytest.mark.parametrize("path", ["/api/session/ws", "/api/document/ws"])
def test_old_host_socket_routes_are_removed(path, minimal_project):
    with pytest.raises(WebSocketDisconnect) as closed:
        with TestClient(create_app()).websocket_connect(
            path + "?" + _url(minimal_project).split("?", 1)[1]
        ):
            pass
    assert closed.value.code == 1000


def test_both_identities_are_authorized_before_accept(minimal_project, monkeypatch):
    identities = []

    def authorize(**kwargs):
        identities.append(kwargs["client_id"])
        return AuthzDecision(kwargs["client_id"] != "document-owner", "document denied")

    monkeypatch.setattr(host, "authorize_client", authorize)
    with pytest.raises(WebSocketDisconnect) as closed:
        with TestClient(create_app()).websocket_connect(_url(minimal_project)):
            pass
    assert identities == ["presence-owner", "document-owner"]
    assert closed.value.code == 4403


def test_strict_remote_requires_host_token(minimal_project, monkeypatch):
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", "owner-secret")
    client = TestClient(create_app())
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(_url(minimal_project, token="wrong")):
            pass
    assert closed.value.code == 4403
    with client.websocket_connect(_url(minimal_project, token="owner-secret")) as socket:
        _hello(socket)


def test_snapshot_barriers_author_ids_and_host_privacy(minimal_project, monkeypatch):
    original = DocumentSyncService.document_snapshot
    published = False
    project = load_project(minimal_project)
    hub = get_hub()
    session_key = str(project.workspace_path())
    document_key = document_hub_key(project)

    def racing_snapshot(self, *args, **kwargs):
        nonlocal published
        snapshot = original(self, *args, **kwargs)
        if not published:
            published = True
            hub.publish(
                session_key,
                {
                    "type": "PresenceDelta",
                    "author_client_id": "peer-session",
                    "roster_version": 99,
                    "changes": {},
                },
            )
            hub.publish(
                document_key,
                {
                    "type": "Applied",
                    "command": {"client_id": "peer-document"},
                    "snapshot": {"server_seq": 99},
                    "_guest_snapshot": {"private": "internal"},
                },
            )
        return snapshot

    monkeypatch.setattr(DocumentSyncService, "document_snapshot", racing_snapshot)
    with TestClient(create_app()).websocket_connect(_url(minimal_project)) as socket:
        session_hello, document_hello = _hello(socket)
        assert "client_id" not in session_hello
        assert "client_id" not in document_hello
        assert {row["client_id"] for row in session_hello["snapshot"]["clients"]} == {
            "presence-owner"
        }
        by_plane = {}
        for _ in range(8):
            frame = socket.receive_json()
            if frame.get("client_id") in {"peer-session", "peer-document"}:
                by_plane[frame["plane"]] = frame
            if len(by_plane) == 2:
                break
        assert by_plane["session"]["client_id"] == "peer-session"
        assert by_plane["session"]["author_client_id"] == "peer-session"
        assert by_plane["document"]["client_id"] == "peer-document"
        assert "_guest_snapshot" not in by_plane["document"]
    assert hub.listener_count(session_key) == hub.listener_count(document_key) == 0
    assert not cross_process_bridge().watching(session_key)


def test_session_work_is_off_loop_and_inbound_commands_stay_ordered(minimal_project, monkeypatch):
    calls = []
    for name in ("submit", "snapshot", "remove_client"):
        original = getattr(SessionSyncService, name)

        def spy(self, *args, _name=name, _original=original, **kwargs):
            try:
                asyncio.get_running_loop()
                on_loop = True
            except RuntimeError:
                on_loop = False
            calls.append((_name, on_loop))
            return _original(self, *args, **kwargs)

        monkeypatch.setattr(SessionSyncService, name, spy)
    with TestClient(create_app()).websocket_connect(_url(minimal_project)) as socket:
        _hello(socket)
        for index, value in enumerate((2.0, 7.0), start=10):
            socket.send_json(
                {
                    "plane": "session",
                    "type": "Command",
                    "command_type": "SetPlayhead",
                    "payload": {"playhead_sec": value},
                    "client_seq": index,
                }
            )
        echoes = []
        while len(echoes) < 2:
            event = receive_host_plane(socket, "session")
            if event["type"] == "Echo":
                echoes.append(event)
        assert [frame["snapshot"]["playhead_sec"] for frame in echoes] == [2.0, 7.0]
        assert all(frame["client_id"] == "presence-owner" for frame in echoes)
    assert {name for name, _ in calls} == {"submit", "snapshot", "remove_client"}
    assert not any(on_loop for _, on_loop in calls)
    assert SessionSyncService(load_project(minimal_project)).snapshot()["playhead_sec"] == 7.0


def test_document_frames_cannot_mutate_and_http_fans_out(minimal_project):
    client = TestClient(create_app())
    with client.websocket_connect(_url(minimal_project)) as socket:
        _hello(socket)
        socket.send_json(
            {
                "plane": "document",
                "type": "Command",
                "command_type": "SetPlayhead",
                "payload": {"playhead_sec": 90},
                "client_seq": 10,
            }
        )
        response = client.post(
            "/api/document/command",
            params={"path": str(minimal_project)},
            json={
                "type": "AddComment",
                "payload": {"body": "HTTP lane", "author": "Owner", "timeline_start": 1},
                "client_id": "document-owner",
                "role": "viewer",
                "client_seq": 1,
            },
        )
        assert response.status_code == 200
        result = response.json()
        frame = receive_host_plane(socket, "document")
        assert frame["type"] == "Applied"
        assert frame["client_id"] == "document-owner"
        assert frame["server_seq"] == result["server_seq"]
        socket.send_json({"type": "ViewerState", "snapshot": {"playhead_sec": 3}})
        while True:
            event = receive_host_plane(socket, "session")
            if event["type"] == "Echo":
                break
        assert event["snapshot"]["playhead_sec"] == 3
    assert len(load_project(minimal_project).comments) == 1


def test_failed_lease_acquisition_releases_both_subscriptions(minimal_project, monkeypatch):
    @asynccontextmanager
    async def unavailable(_workspace):
        raise RuntimeError("watcher unavailable")
        yield

    monkeypatch.setattr(host, "cross_process_lease", unavailable)
    with pytest.raises(RuntimeError, match="watcher unavailable"):
        with TestClient(create_app()).websocket_connect(_url(minimal_project)) as socket:
            socket.receive_json()
    project = load_project(minimal_project)
    assert get_hub().listener_count(str(project.workspace_path())) == 0
    assert get_hub().listener_count(document_hub_key(project)) == 0


def test_malformed_input_is_bounded(minimal_project):
    with TestClient(create_app()).websocket_connect(_url(minimal_project)) as socket:
        _hello(socket)
        for _ in range(21):
            socket.send_text("not JSON")
        with pytest.raises(WebSocketDisconnect) as closed:
            for _ in range(8):
                socket.receive_json()
        assert closed.value.code == 4400


def test_host_hello_reuses_one_certified_project_load(minimal_project, monkeypatch):
    from podcast_mcp.project_store import ProjectStore

    original = ProjectStore.load
    reads = []

    def count(self, *args, **kwargs):
        reads.append(True)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(ProjectStore, "load", count)
    with TestClient(create_app()).websocket_connect(_url(minimal_project)) as socket:
        _hello(socket)
        assert len(reads) == 1


@pytest.mark.parametrize("attempt", range(3))
def test_client_shutdown_finishes_cleanup_through_repeated_cancel_checkpoints(
    minimal_project, monkeypatch, attempt
):
    import anyio

    from podcast_mcp.gui.routes.guest_ws_common import WsTaskSet

    stopped = []
    removed = []
    original_stop = WsTaskSet.stop
    original_remove = SessionSyncService.remove_client

    async def checkpoints(self):
        await original_stop(self)
        for _ in range(8):
            await anyio.lowlevel.checkpoint()
        stopped.append(True)

    def remove(self, *args, **kwargs):
        original_remove(self, *args, **kwargs)
        removed.append(True)

    monkeypatch.setattr(WsTaskSet, "stop", checkpoints)
    monkeypatch.setattr(SessionSyncService, "remove_client", remove)
    with TestClient(create_app()).websocket_connect(
        _url(minimal_project, client_id=f"close-{attempt}")
    ) as socket:
        _hello(socket)
    assert len(stopped) == 2
    assert removed == [True]
    project = load_project(minimal_project)
    assert SessionSyncService(project).snapshot()["clients"] == []
    assert get_hub().listener_count(str(project.workspace_path())) == 0
    assert get_hub().listener_count(document_hub_key(project)) == 0
    assert not cross_process_bridge().watching(str(project.workspace_path()))


def test_retired_host_connection_cannot_remove_replacement_presence(minimal_project):
    service = SessionSyncService(load_project(minimal_project))
    with TestClient(create_app()) as client:
        retired = client.websocket_connect(_url(minimal_project))
        old_socket = retired.__enter__()
        exited = False
        try:
            _hello(old_socket)
            with client.websocket_connect(_url(minimal_project)) as replacement:
                _hello(replacement)
                retired.__exit__(None, None, None)
                exited = True
                assert any(
                    row["client_id"] == "presence-owner" for row in service.store.list_clients()
                )
        finally:
            if not exited:
                retired.__exit__(None, None, None)
        assert not any(row["client_id"] == "presence-owner" for row in service.store.list_clients())


def test_failed_host_presence_claim_does_not_remove_live_connection(minimal_project, monkeypatch):
    service = SessionSyncService(load_project(minimal_project))
    with TestClient(create_app()) as client:
        with client.websocket_connect(_url(minimal_project)) as live:
            _hello(live)

            def unavailable(self, client_id):
                raise RuntimeError("presence claim unavailable")

            monkeypatch.setattr(SessionSyncService, "claim_client", unavailable)
            with pytest.raises(RuntimeError, match="presence claim unavailable"):
                with client.websocket_connect(_url(minimal_project)) as failed:
                    failed.receive_json()
            assert any(row["client_id"] == "presence-owner" for row in service.store.list_clients())
