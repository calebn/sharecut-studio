"""Tests for the cross-process journal watcher (#695)."""

from __future__ import annotations

import asyncio
import logging
import multiprocessing as mp
import threading
import time
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project
from podcast_mcp.services import cross_process_sync
from podcast_mcp.services.cross_process_sync import (
    CrossProcessBridge,
    CrossProcessWatcher,
    _Plane,
    cross_process_bridge,
)
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.service import (
    EXTERNAL_MUTATE_CLIENT_ID,
    DocumentSyncService,
)
from podcast_mcp.services.session_sync.commands import SyncCommand
from podcast_mcp.services.session_sync.hub import get_hub
from podcast_mcp.services.session_sync.service import SessionSyncService
from podcast_mcp.services.workspace import ProjectWorkspace
from process_helpers import reap
from sync_helpers import _foreign_document_write, _foreign_session_write

_CTX = mp.get_context("spawn")


@pytest.fixture(autouse=True)
def _stop_bridge_after():
    yield
    cross_process_bridge().stop_all()


def _drain(q: asyncio.Queue) -> list[dict]:
    """Pop everything currently queued and return only the ``Applied`` events."""
    out: list[dict] = []
    while True:
        try:
            event = q.get_nowait()
        except asyncio.QueueEmpty:
            return out
        if event.get("type") == "Applied":
            out.append(event)


def test_plane_baselines_then_publishes_only_foreign_advances():
    values: list[int | None] = [3]
    calls: list[int | None] = []

    def read_seq() -> int | None:
        return values[-1]

    def publish_head(after: int | None) -> dict | None:
        calls.append(after)
        return {"published": values[-1]}

    hub_key = "plane-test-key"
    plane = _Plane("test", hub_key, read_seq, publish_head)

    plane.baseline()
    assert plane.poll() is None  # same as baseline
    assert calls == []

    values.append(4)
    assert plane.poll() == {"published": 4}
    assert calls == [3]

    assert plane.poll() is None  # no new advance
    assert calls == [3]

    get_hub().publish(hub_key, {"type": "Applied", "server_seq": 5})
    values.append(5)
    assert plane.poll() is None  # every row in (4, 5] was published in this process
    assert calls == [3]

    values.append(None)
    prev_seen = plane.seen
    assert plane.poll() is None
    assert plane.seen == prev_seen  # unreadable tick leaves seen unchanged

    values.append(0)
    assert plane.poll() is None
    assert plane.seen == 0

    assert calls == [3]


def test_watcher_tick_skips_idle_projects(minimal_project, monkeypatch):
    ws = ProjectWorkspace.open(minimal_project)
    watcher = CrossProcessWatcher(ws, interval=10.0)
    for p in watcher.planes:
        p.baseline()

    calls: list[str] = []
    monkeypatch.setattr(
        SessionSyncService,
        "publish_cross_process_head",
        lambda self, after=None: calls.append("session") or None,
    )

    proj = load_project(minimal_project)
    _foreign_session_write(proj, 3.0)
    watcher.tick()
    assert calls == []


def test_watcher_tick_publishes_foreign_session_and_document_heads(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    watcher = CrossProcessWatcher(ws, interval=10.0)

    loop = asyncio.new_event_loop()
    session_key, document_key = watcher.planes[0].hub_key, watcher.planes[1].hub_key
    hub = get_hub()
    try:
        q_session = hub.subscribe(session_key, loop)
        q_document = hub.subscribe(document_key, loop)
        for p in watcher.planes:
            p.baseline()

        proj = load_project(minimal_project)
        _foreign_session_write(proj, 6.0)
        _foreign_document_write(proj)

        watcher.tick()
        loop.run_until_complete(asyncio.sleep(0))

        session_event = q_session.get_nowait()
        assert session_event["type"] == "Applied"
        assert session_event["command"]["type"] == "SetPlayhead"

        document_event = q_document.get_nowait()
        assert document_event["type"] == "Applied"
        assert document_event["command"]["type"] == "ExternalMutate"
        assert "project" in document_event["snapshot"]

        watcher.tick()
        loop.run_until_complete(asyncio.sleep(0))
        with pytest.raises(asyncio.QueueEmpty):
            q_session.get_nowait()
        with pytest.raises(asyncio.QueueEmpty):
            q_document.get_nowait()
    finally:
        hub.unsubscribe(session_key, q_session)
        hub.unsubscribe(document_key, q_document)
        loop.close()


def test_watcher_does_not_republish_in_process_writes(minimal_project):
    from podcast_mcp.services.document_sync.commands import DocumentCommand

    ws = ProjectWorkspace.open(minimal_project)
    watcher = CrossProcessWatcher(ws, interval=10.0)
    session_key, document_key = watcher.planes[0].hub_key, watcher.planes[1].hub_key
    hub = get_hub()
    loop = asyncio.new_event_loop()
    try:
        q_session = hub.subscribe(session_key, loop)
        q_document = hub.subscribe(document_key, loop)
        for p in watcher.planes:
            p.baseline()

        proj = load_project(minimal_project)
        SessionSyncService(proj).submit_control("SetPlayhead", {"playhead_sec": 2.0})
        DocumentSyncService.open(minimal_project).submit(
            DocumentCommand(
                type="AddComment",
                payload={"body": "note", "author": "viewer", "timeline_start": 0.5},
                client_id="c1",
                role="viewer",
                client_seq=1,
            )
        )
        watcher.tick()
        loop.run_until_complete(asyncio.sleep(0))

        session_count = 0
        while True:
            try:
                q_session.get_nowait()
                session_count += 1
            except asyncio.QueueEmpty:
                break
        document_count = 0
        while True:
            try:
                q_document.get_nowait()
                document_count += 1
            except asyncio.QueueEmpty:
                break
        assert session_count == 1
        assert document_count == 1
    finally:
        hub.unsubscribe(session_key, q_session)
        hub.unsubscribe(document_key, q_document)
        loop.close()


def test_watcher_tick_logs_and_continues_when_a_plane_fails(minimal_project, monkeypatch, caplog):
    ws = ProjectWorkspace.open(minimal_project)
    watcher = CrossProcessWatcher(ws, interval=10.0)
    session_key, document_key = watcher.planes[0].hub_key, watcher.planes[1].hub_key
    hub = get_hub()
    loop = asyncio.new_event_loop()
    try:
        q_session = hub.subscribe(session_key, loop)
        q_document = hub.subscribe(document_key, loop)
        for p in watcher.planes:
            p.baseline()

        def _boom(after):
            raise RuntimeError("session publish failed")

        monkeypatch.setattr(watcher.planes[0], "publish_head", _boom)

        proj = load_project(minimal_project)
        _foreign_session_write(proj, 5.0)
        _foreign_document_write(proj)

        with caplog.at_level(logging.WARNING):
            watcher.tick()
        loop.run_until_complete(asyncio.sleep(0))

        assert any("session" in r.message for r in caplog.records)
        document_event = q_document.get_nowait()
        assert document_event["command"]["type"] == "ExternalMutate"
    finally:
        hub.unsubscribe(session_key, q_session)
        hub.unsubscribe(document_key, q_document)
        loop.close()


def test_bridge_refcounts_one_watcher_per_workspace(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    bridge = CrossProcessBridge(interval=0.01)
    key = str(ws.project.workspace_path())

    lease1 = bridge.acquire(ws)
    lease2 = bridge.acquire(ws)
    assert bridge.watching(key)

    lease1.release()
    assert bridge.watching(key)

    lease2.release()
    assert not bridge.watching(key)
    lease2.release()  # no-op


def test_bridge_acquire_failure_returns_a_noop_lease(minimal_project, monkeypatch, caplog):
    ws = ProjectWorkspace.open(minimal_project)
    bridge = CrossProcessBridge(interval=0.01)
    key = str(ws.project.workspace_path())

    def _boom(self):
        raise RuntimeError("cannot start")

    monkeypatch.setattr(CrossProcessWatcher, "start", _boom)
    with caplog.at_level(logging.WARNING):
        lease = bridge.acquire(ws)
    assert not bridge.watching(key)
    assert any("Could not watch" in r.message for r in caplog.records)
    lease.release()  # does not raise


def test_watcher_thread_pushes_a_foreign_write(minimal_project, monkeypatch):
    monkeypatch.setattr(cross_process_sync, "CROSS_PROCESS_POLL_S", 0.02)
    ws = ProjectWorkspace.open(minimal_project)
    bridge = CrossProcessBridge(interval=0.02)
    hub = get_hub()
    key = str(ws.project.workspace_path())
    loop = asyncio.new_event_loop()
    try:
        q = hub.subscribe(key, loop)
        lease = bridge.acquire(ws)
        try:
            proj = load_project(minimal_project)
            _foreign_session_write(proj, 8.25)
            event = loop.run_until_complete(asyncio.wait_for(q.get(), 5))
            assert event["type"] == "Applied"
            assert event["snapshot"]["playhead_sec"] == 8.25
        finally:
            lease.release()
    finally:
        hub.unsubscribe(key, q)
        loop.close()


def _child_seek(path: str) -> None:
    from podcast_mcp.services.session_control import SessionControlService
    from podcast_mcp.services.workspace import ProjectWorkspace as _PW

    SessionControlService(_PW.open(path)).seek(4.0)


def _child_notify(path: str) -> None:
    from podcast_mcp.services.document_sync.service import notify_document_changed

    notify_document_changed(path)


def test_watcher_bridges_a_seek_from_another_process(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    watcher = CrossProcessWatcher(ws, interval=10.0)
    session_key = watcher.planes[0].hub_key
    hub = get_hub()
    loop = asyncio.new_event_loop()
    try:
        q = hub.subscribe(session_key, loop)
        for p in watcher.planes:
            p.baseline()

        child = _CTX.Process(target=_child_seek, args=(str(minimal_project),))
        child.start()
        assert reap(child, 120)
        assert child.exitcode == 0

        watcher.tick()
        loop.run_until_complete(asyncio.sleep(0))
        event = q.get_nowait()
        assert event["type"] == "Applied"
        assert event["snapshot"]["playhead_sec"] == 4.0
        assert event["command"]["role"] == "agent"
    finally:
        hub.unsubscribe(session_key, q)
        loop.close()


def test_document_ws_leases_before_hello_and_releases_on_close(minimal_project, monkeypatch):
    events: list[str] = []

    class _FakeLease:
        def release(self) -> None:
            events.append("release")

    def _fake_watch(ws_proj):
        events.append("acquire")
        return _FakeLease()

    original_snapshot = DocumentSyncService.document_snapshot

    def _spy_snapshot(self, *args, **kwargs):
        events.append("snapshot")
        return original_snapshot(self, *args, **kwargs)

    monkeypatch.setattr(cross_process_sync, "watch_cross_process_writes", _fake_watch)
    monkeypatch.setattr(DocumentSyncService, "document_snapshot", _spy_snapshot)

    client = TestClient(create_app())
    url = f"/api/document/ws?path={quote(str(minimal_project))}&client_id=lease-doc&role=viewer"
    with client.websocket_connect(url) as ws:
        assert ws.receive_json()["type"] == "Snapshot"

    assert events[:2] == ["acquire", "snapshot"]
    assert events[-1] == "release"


def test_session_ws_leases_before_hello_and_releases_on_close(minimal_project, monkeypatch):
    events: list[str] = []

    class _FakeLease:
        def release(self) -> None:
            events.append("release")

    def _fake_watch(ws_proj):
        events.append("acquire")
        return _FakeLease()

    original_snapshot = SessionSyncService.snapshot

    def _spy_snapshot(self, *args, **kwargs):
        events.append("snapshot")
        return original_snapshot(self, *args, **kwargs)

    monkeypatch.setattr(cross_process_sync, "watch_cross_process_writes", _fake_watch)
    monkeypatch.setattr(SessionSyncService, "snapshot", _spy_snapshot)

    client = TestClient(create_app())
    url = f"/api/session/ws?path={quote(str(minimal_project))}&client_id=lease-sess&role=viewer"
    with client.websocket_connect(url) as ws:
        assert ws.receive_json()["type"] == "Snapshot"

    assert events[0] == "acquire"
    # release runs in the socket's finally, before the post-disconnect presence
    # broadcast (remove_client) takes its own snapshot.
    assert "release" in events
    assert events.index("release") > events.index("acquire")


def test_session_ws_pushes_a_foreign_write_live(minimal_project, monkeypatch):
    monkeypatch.setattr(cross_process_sync, "CROSS_PROCESS_POLL_S", 0.02)
    client = TestClient(create_app())
    url = f"/api/session/ws?path={quote(str(minimal_project))}&client_id=live-sess&role=viewer"
    key = str(ProjectWorkspace.open(minimal_project).project.workspace_path())
    with client.websocket_connect(url) as ws:
        frame = ws.receive_json()
        while frame.get("type") != "Snapshot":
            frame = ws.receive_json()

        proj = load_project(minimal_project)
        _foreign_session_write(proj, 6.5)

        applied = None
        for _ in range(20):
            frame = ws.receive_json()
            if frame.get("type") == "Applied":
                applied = frame
                break
        assert applied is not None
        assert applied["command"]["type"] == "SetPlayhead"
        assert applied["snapshot"]["playhead_sec"] == 6.5

    assert not cross_process_bridge().watching(key)


def test_document_ws_pushes_a_foreign_write_once_and_never_repeats_own_writes(
    minimal_project, monkeypatch
):
    from podcast_mcp.services.document_sync.commands import DocumentCommand

    monkeypatch.setattr(cross_process_sync, "CROSS_PROCESS_POLL_S", 0.02)
    client = TestClient(create_app())
    url = f"/api/document/ws?path={quote(str(minimal_project))}&client_id=live-doc&role=viewer"
    with client.websocket_connect(url) as ws:
        assert ws.receive_json()["type"] == "Snapshot"

        applied = DocumentSyncService.open(minimal_project).submit(
            DocumentCommand(
                type="AddComment",
                payload={"body": "own", "author": "viewer", "timeline_start": 0.5},
                client_id="live-doc",
                role="viewer",
                client_seq=1,
            )
        )
        own_seq = applied["server_seq"]
        first = ws.receive_json()
        assert first["type"] == "Applied"
        assert first["server_seq"] == own_seq

        time.sleep(0.2)  # let several watcher ticks pass with nothing foreign

        proj = load_project(minimal_project)
        _foreign_document_write(proj)

        second = ws.receive_json()
        assert second["type"] == "Applied"
        assert second["server_seq"] == own_seq + 1
        assert second["command"]["type"] == "ExternalMutate"


def test_watcher_bridges_an_mcp_notify_from_another_process(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    watcher = CrossProcessWatcher(ws, interval=10.0)
    document_key = watcher.planes[1].hub_key
    hub = get_hub()
    loop = asyncio.new_event_loop()
    try:
        q = hub.subscribe(document_key, loop)
        for p in watcher.planes:
            p.baseline()

        child = _CTX.Process(target=_child_notify, args=(str(minimal_project),))
        child.start()
        assert reap(child, 120)
        assert child.exitcode == 0

        watcher.tick()
        loop.run_until_complete(asyncio.sleep(0))
        event = q.get_nowait()
        assert event["command"]["type"] == "ExternalMutate"
    finally:
        hub.unsubscribe(document_key, q)
        loop.close()


def test_watcher_publishes_a_foreign_agent_row_an_in_process_write_landed_on(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    watcher = CrossProcessWatcher(ws, interval=10.0)
    session_key = watcher.planes[0].hub_key
    hub = get_hub()
    loop = asyncio.new_event_loop()
    try:
        q = hub.subscribe(session_key, loop)
        for p in watcher.planes:
            p.baseline()

        proj = load_project(minimal_project)
        agent = _foreign_session_write(
            proj, 0.0, command_type="SetPlaying", payload={"is_playing": True}
        )
        own = SessionSyncService(proj).submit(
            SyncCommand(
                type="SetRegion",
                payload={"start_sec": 1.0, "end_sec": 2.0},
                client_id="viewer-tab",
                role="viewer",
                client_seq=1,
            )
        )

        watcher.tick()
        loop.run_until_complete(asyncio.sleep(0))
        events = _drain(q)

        assert [e["command"]["command_id"] for e in events] == [
            own["command"]["command_id"],
            agent["command_id"],
        ]
        bridged = events[-1]
        assert bridged["server_seq"] == own["server_seq"]
        assert bridged["command"]["role"] == "agent"
        assert bridged["snapshot"]["last_command_id"] == agent["command_id"]
        assert bridged["snapshot"]["last_role"] == "agent"
        assert bridged["snapshot"]["is_playing"] is True

        watcher.tick()
        loop.run_until_complete(asyncio.sleep(0))
        assert _drain(q) == []
    finally:
        hub.unsubscribe(session_key, q)
        loop.close()


def test_watcher_reports_the_agent_row_when_two_foreign_writers_collapse(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    watcher = CrossProcessWatcher(ws, interval=10.0)
    session_key = watcher.planes[0].hub_key
    hub = get_hub()
    loop = asyncio.new_event_loop()
    try:
        q = hub.subscribe(session_key, loop)
        for p in watcher.planes:
            p.baseline()

        proj = load_project(minimal_project)
        agent = _foreign_session_write(
            proj, 0.0, command_type="SetPlaying", payload={"is_playing": True}
        )
        viewer = _foreign_session_write(
            proj,
            0.0,
            command_type="SetRegion",
            payload={"start_sec": 1.0, "end_sec": 2.0},
            role="viewer",
            client_id="other-gui",
        )

        watcher.tick()
        loop.run_until_complete(asyncio.sleep(0))
        events = _drain(q)

        assert len(events) == 1
        event = events[0]
        assert event["server_seq"] == viewer["server_seq"]
        assert event["command"]["command_id"] == agent["command_id"]
        assert event["snapshot"]["last_role"] == "agent"
    finally:
        hub.unsubscribe(session_key, q)
        loop.close()


def test_watcher_publishes_a_foreign_document_row_an_in_process_write_landed_on(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    watcher = CrossProcessWatcher(ws, interval=10.0)
    document_key = watcher.planes[1].hub_key
    hub = get_hub()
    loop = asyncio.new_event_loop()
    try:
        q = hub.subscribe(document_key, loop)
        for p in watcher.planes:
            p.baseline()

        proj = load_project(minimal_project)
        foreign = _foreign_document_write(proj)
        own = DocumentSyncService.open(minimal_project).submit(
            DocumentCommand(
                type="AddComment",
                payload={"body": "note", "author": "viewer", "timeline_start": 0.5},
                client_id="c1",
                role="viewer",
                client_seq=1,
            )
        )

        watcher.tick()
        loop.run_until_complete(asyncio.sleep(0))
        events = _drain(q)

        assert len(events) == 2
        bridged = events[-1]
        assert bridged["server_seq"] == own["server_seq"]
        assert bridged["snapshot"]["server_seq"] == own["server_seq"]
        assert bridged["command"]["command_id"] == foreign["command_id"]
        assert bridged["command"]["client_id"] == EXTERNAL_MUTATE_CLIENT_ID
        assert "project" in bridged["snapshot"]
    finally:
        hub.unsubscribe(document_key, q)
        loop.close()


def test_cross_process_lease_releases_when_the_body_raises(minimal_project, monkeypatch):
    class _FakeLease:
        def __init__(self) -> None:
            self.released = 0

        def release(self) -> None:
            self.released += 1

    fake_lease = _FakeLease()
    monkeypatch.setattr(cross_process_sync, "watch_cross_process_writes", lambda ws: fake_lease)

    async def _run() -> None:
        ws = ProjectWorkspace.open(minimal_project)
        async with cross_process_sync.cross_process_lease(ws):
            raise RuntimeError("unsubscribe failed")

    with pytest.raises(RuntimeError):
        asyncio.run(_run())

    assert fake_lease.released == 1


def test_cross_process_lease_releases_a_lease_acquired_after_cancellation(
    minimal_project, monkeypatch
):
    started = threading.Event()
    proceed = threading.Event()
    released = threading.Event()

    class _FakeLease:
        def release(self) -> None:
            released.set()

    def _slow_watch(ws):
        started.set()
        proceed.wait(5)
        return _FakeLease()

    monkeypatch.setattr(cross_process_sync, "watch_cross_process_writes", _slow_watch)

    async def _run() -> None:
        ws = ProjectWorkspace.open(minimal_project)

        async def _body() -> None:
            async with cross_process_sync.cross_process_lease(ws):
                await asyncio.sleep(10)

        task = asyncio.ensure_future(_body())
        await asyncio.to_thread(started.wait, 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        proceed.set()
        await asyncio.to_thread(released.wait, 5)

    asyncio.run(_run())
    assert released.is_set()


def test_bridge_acquire_returns_a_noop_lease_when_the_workspace_path_fails(
    minimal_project, monkeypatch, caplog
):
    ws = ProjectWorkspace.open(minimal_project)
    bridge = CrossProcessBridge(interval=0.01)
    key = str(ws.project.workspace_path())

    def _boom(self):
        raise OSError("workspace gone")

    monkeypatch.setattr(type(ws.project), "workspace_path", _boom)
    with caplog.at_level(logging.WARNING):
        lease = bridge.acquire(ws)
    monkeypatch.undo()

    assert not bridge.watching(key)
    assert any("Could not watch" in r.message for r in caplog.records)
    lease.release()  # does not raise


def test_plane_retries_a_failing_publish_then_gives_up():
    values: list[int | None] = [1]
    attempts: list[int | None] = []
    fail = [True]

    def read_seq() -> int | None:
        return values[-1]

    def publish_head(after: int | None) -> dict | None:
        attempts.append(after)
        if fail[0]:
            raise RuntimeError("publish failed")
        return {"after": after}

    plane = _Plane("test", "plane-retry-key", read_seq, publish_head)
    plane.baseline()
    values.append(2)

    with pytest.raises(RuntimeError):
        plane.poll()
    assert plane.seen == 1

    fail[0] = False
    assert plane.poll() == {"after": 1}
    assert plane.seen == 2

    fail[0] = True
    values.append(3)
    for _ in range(cross_process_sync._PUBLISH_ATTEMPTS):
        with pytest.raises(RuntimeError):
            plane.poll()

    assert plane.seen == 3
    assert plane.poll() is None
    assert attempts == [1, 1] + [2] * cross_process_sync._PUBLISH_ATTEMPTS


def test_plane_publishes_the_head_when_the_baseline_read_failed():
    values: list[int | None] = [None]
    calls: list[int | None] = []

    plane = _Plane(
        "test",
        "plane-baseline-key",
        lambda: values[-1],
        lambda after: calls.append(after) or {"head": values[-1]},
    )
    plane.baseline()
    assert plane.seen is None

    values.append(7)
    assert plane.poll() == {"head": 7}
    assert calls == [None]
    assert plane.seen == 7

    published = _Plane(
        "test", "plane-baseline-key-2", lambda: 9, lambda after: calls.append(after) or {}
    )
    get_hub().publish("plane-baseline-key-2", {"type": "Applied", "server_seq": 9})
    assert published.poll() is None
    assert calls == [None]


def test_app_shutdown_stops_the_cross_process_watchers(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    key = str(ws.project.workspace_path())

    with TestClient(create_app()):
        lease = cross_process_bridge().acquire(ws)
        assert cross_process_bridge().watching(key)

    assert not cross_process_bridge().watching(key)
    lease.release()  # no-op
