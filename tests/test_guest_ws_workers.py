from __future__ import annotations

import asyncio
import json
import threading
from concurrent.futures import CancelledError, ThreadPoolExecutor
from contextlib import suppress
from pathlib import Path
from unittest.mock import AsyncMock

import anyio
import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.routes import guest_ws_common as common
from podcast_mcp.gui.routes import record_share, review_share
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.record.service import RecordSessionService
from podcast_mcp.services.remote_mcp.limits import reset_host_limiters_for_tests
from podcast_mcp.services.session_sync.service import SessionSyncService


@pytest.fixture
def shared_workspace(minimal_project, sample_wav):
    project = load_project(minimal_project)
    artifacts = Path(project.workspace_dir) / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(project, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def review_token(workspace):
    version = ReviewService(workspace).publish(label="Workers")
    return ShareService(workspace).create(
        review_version_id=version["id"], capabilities=["play", "view"]
    )["token"]


class BlockedCall:
    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.threads = []

    def wait(self):
        self.threads.append(threading.get_ident())
        self.entered.set()
        assert self.release.wait(5), "socket work blocked the event-loop heartbeat"

    async def heartbeat(self):
        self.release.set()
        return threading.get_ident()


@pytest.mark.parametrize("operation", ["admission", "snapshot", "presence"])
def test_guest_daw_workers_leave_loop_responsive_and_preserve_order(
    shared_workspace, monkeypatch, operation
):
    token = review_token(shared_workspace)
    blocked = BlockedCall()
    handled = []
    complete = threading.Event()
    handler = review_share._handle_guest_presence_frame

    def handle(text, **kwargs):
        if operation == "presence" and not handled:
            blocked.wait()
        result = handler(text, **kwargs)
        handled.append(json.loads(text)["client_seq"])
        if len(handled) == 2:
            complete.set()
        return result

    monkeypatch.setattr(review_share, "_handle_guest_presence_frame", handle)
    if operation == "admission":
        lookup = common.lookup_share

        def resolve(*args, **kwargs):
            blocked.wait()
            return lookup(*args, **kwargs)

        monkeypatch.setattr(common, "lookup_share", resolve)
    elif operation == "snapshot":
        snapshot = DocumentSyncService.document_snapshot

        def project_snapshot(self, **kwargs):
            blocked.wait()
            return snapshot(self, **kwargs)

        monkeypatch.setattr(DocumentSyncService, "document_snapshot", project_snapshot)

    with TestClient(create_app()) as client, ThreadPoolExecutor(max_workers=1) as pool:

        def connect():
            with client.websocket_connect(f"/api/review/{token}/daw/ws") as socket:
                assert socket.receive_json()["plane"] == "session"
                assert socket.receive_json()["plane"] == "document"
                socket.send_json({"type": "Presence", "client_seq": 2, "playhead_sec": 1})
                socket.send_json({"type": "Presence", "client_seq": 3, "playhead_sec": 2})
                assert complete.wait(5)

        future = pool.submit(connect)
        try:
            assert blocked.entered.wait(5)
            loop_thread = client.portal.call(blocked.heartbeat)
            future.result(timeout=5)
        finally:
            blocked.release.set()
    assert handled == [2, 3]
    assert all(worker != loop_thread for worker in blocked.threads)


@pytest.mark.parametrize("operation", ["join", "command"])
def test_guest_record_workers_preserve_join_barrier_and_command_order(
    shared_workspace, monkeypatch, operation
):
    token = ShareService(shared_workspace).create_record_room()["guest"]["token"]
    blocked = BlockedCall()
    commands = []
    join = RecordSessionService.join
    dispatch = record_share.route_record_ws_message

    def joining(self, **kwargs):
        result = join(self, **kwargs)
        if operation == "join":
            blocked.wait()
        return result

    def route(*args, **kwargs):
        if operation == "command" and not commands:
            blocked.wait()
        result = dispatch(*args, **kwargs)
        commands.append(args[1]["client_seq"])
        return result

    monkeypatch.setattr(RecordSessionService, "join", joining)
    monkeypatch.setattr(record_share, "route_record_ws_message", route)
    with TestClient(create_app()) as client, ThreadPoolExecutor(max_workers=1) as pool:

        def connect():
            with client.websocket_connect(f"/api/rec/{token}/ws") as socket:
                socket.send_json(
                    {
                        "type": "Record",
                        "command_type": "Join",
                        "client_seq": 1,
                        "payload": {"display_name": "Worker guest"},
                    }
                )
                assert socket.receive_json()["type"] == "Echo"
                assert socket.receive_json()["type"] == "Snapshot"
                for seq in (2, 3):
                    socket.send_json(
                        {
                            "type": "Record",
                            "command_type": "HeadphonesAck",
                            "client_seq": seq,
                            "payload": {"ok": True},
                        }
                    )
                echoes = []
                while len(echoes) < 2:
                    frame = socket.receive_json()
                    assert frame.get("type") != "Error", frame
                    if frame.get("type") == "Echo":
                        echoes.append(frame)

        future = pool.submit(connect)
        try:
            assert blocked.entered.wait(5)
            loop_thread = client.portal.call(blocked.heartbeat)
            future.result(timeout=5)
        finally:
            blocked.release.set()
    assert commands == [2, 3]
    assert all(worker != loop_thread for worker in blocked.threads)


@pytest.mark.asyncio
async def test_frame_validation_waits_for_inflight_revocation_without_blocking_loop():
    blocked = BlockedCall()
    decisions = []

    def valid():
        blocked.wait()
        decisions.append(False)
        return False

    guard = common.GuestWsGuard(AsyncMock(), valid, on_frame=0)
    first = asyncio.create_task(guard.share_ok_on_frame())
    assert await asyncio.to_thread(blocked.entered.wait, 3)
    second = asyncio.create_task(guard.share_ok_on_frame())
    await asyncio.sleep(0)
    assert not second.done()
    await blocked.heartbeat()
    assert await first is False
    assert await second is False
    assert decisions == [False]


@pytest.mark.parametrize("kind", ["daw", "record"])
def test_guest_shutdown_finishes_worker_cleanup_before_return(shared_workspace, monkeypatch, kind):
    finished = []
    original_stop = common.GuestWsConnection.stop_tasks

    async def stop(connection):
        for _ in range(8):
            await anyio.sleep(0)
        await original_stop(connection)
        finished.append("tasks")

    monkeypatch.setattr(common.GuestWsConnection, "stop_tasks", stop)
    original_release = common.GuestWsConnection.release

    def release(connection):
        assert finished == ["tasks", "service"]
        original_release(connection)
        finished.append("released")

    monkeypatch.setattr(common.GuestWsConnection, "release", release)
    if kind == "daw":
        token = review_token(shared_workspace)
        original = SessionSyncService.remove_client

        def remove(self, *args, **kwargs):
            with pytest.raises(RuntimeError, match="no running event loop"):
                asyncio.get_running_loop()
            original(self, *args, **kwargs)
            finished.append("service")

        monkeypatch.setattr(SessionSyncService, "remove_client", remove)
        path = f"/api/review/{token}/daw/ws"
    else:
        token = ShareService(shared_workspace).create_record_room()["guest"]["token"]
        original = RecordSessionService.disconnect

        def disconnect(self, *args, **kwargs):
            with pytest.raises(RuntimeError, match="no running event loop"):
                asyncio.get_running_loop()
            original(self, *args, **kwargs)
            finished.append("service")

        monkeypatch.setattr(RecordSessionService, "disconnect", disconnect)
        path = f"/api/rec/{token}/ws"
    with TestClient(create_app()) as client:
        with client.websocket_connect(path) as socket:
            if kind == "record":
                socket.send_json(
                    {
                        "type": "Record",
                        "command_type": "Join",
                        "client_seq": 1,
                        "payload": {"display_name": "Shutdown"},
                    }
                )
            socket.receive_json()
            socket.receive_json()
        assert finished == ["tasks", "service", "released"]


def test_failed_guest_claim_preserves_existing_live_presence(shared_workspace, monkeypatch):
    token = review_token(shared_workspace)
    path = f"/api/review/{token}/daw/ws?client_id=stable-tab"
    service = SessionSyncService(shared_workspace.project)
    with TestClient(create_app()) as client:
        with client.websocket_connect(path) as live:
            first = live.receive_json()
            client_id = first["client_id"]
            assert live.receive_json()["plane"] == "document"

            def fail_claim(self, identifier):
                raise RuntimeError("claim failed before acquisition")

            monkeypatch.setattr(SessionSyncService, "claim_client", fail_claim)
            with pytest.raises(RuntimeError, match="claim failed before acquisition"):
                with client.websocket_connect(path) as failed:
                    failed.receive_json()
            assert any(row["client_id"] == client_id for row in service.snapshot()["clients"])


def test_rejected_record_connection_does_not_construct_service(shared_workspace, monkeypatch):
    token = ShareService(shared_workspace).create_record_room()["guest"]["token"]
    monkeypatch.setenv("PODCAST_GUEST_WS_CONCURRENT", "1")
    reset_host_limiters_for_tests()
    limiter = common.get_host_limiters().guest_ws_concurrent
    assert limiter.try_enter(token).allowed
    constructed = []
    original = RecordSessionService.__init__

    def construct(self, *args, **kwargs):
        constructed.append(True)
        original(self, *args, **kwargs)

    monkeypatch.setattr(RecordSessionService, "__init__", construct)
    try:
        with TestClient(create_app()) as client:
            with client.websocket_connect(f"/api/rec/{token}/ws") as socket:
                frame = socket.receive()
                assert frame["type"] == "websocket.close"
                assert frame["code"] == 4429
        assert constructed == []
    finally:
        limiter.exit(token)
        reset_host_limiters_for_tests()


def test_cancelled_claim_reply_cannot_remove_a_newer_guest_connection(
    shared_workspace, monkeypatch
):
    token = review_token(shared_workspace)
    path = f"/api/review/{token}/daw/ws?client_id=stable-replacement"
    service = SessionSyncService(shared_workspace.project)
    claimed = threading.Event()
    released = threading.Event()
    held_tasks = []
    original_worker = review_share.run_in_threadpool
    original_release = common.GuestWsConnection.release

    async def worker(function, *args, **kwargs):
        result = await original_worker(function, *args, **kwargs)
        if getattr(function, "__name__", "") == "claim_client" and not held_tasks:
            held_tasks.append(asyncio.current_task())
            claimed.set()
            await asyncio.Event().wait()
        return result

    def release(connection):
        original_release(connection)
        if held_tasks and asyncio.current_task() is held_tasks[0]:
            released.set()

    async def cancel_claim():
        held_tasks[0].cancel()
        await asyncio.sleep(0)

    with TestClient(create_app()) as client:
        with client.websocket_connect(path) as live:
            first = live.receive_json()
            client_id = first["client_id"]
            live.receive_json()
            monkeypatch.setattr(review_share, "run_in_threadpool", worker)
            monkeypatch.setattr(common.GuestWsConnection, "release", release)
            with suppress(CancelledError):
                with client.websocket_connect(path):
                    assert claimed.wait(5)
                    with client.websocket_connect(path) as replacement:
                        assert replacement.receive_json()["client_id"] == client_id
                        replacement.receive_json()
                        client.portal.call(cancel_claim)
                        assert released.wait(5)
                        assert any(
                            row["client_id"] == client_id for row in service.snapshot()["clients"]
                        )
