"""Guest progress hub, MCP notifications, and review-share WS isolation."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.guest_progress import (
    GuestWsProgressReporter,
    guest_progress_hub,
    guest_progress_payload,
    guest_ws_progress_sink,
    reset_guest_progress_hub,
    scrub_guest_progress_text,
)
from podcast_mcp.services.remote_mcp.progress import (
    GuestMcpProgressContext,
    McpProgressSink,
)
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.services.share import ShareService
from podcast_mcp.util.progress import (
    ProgressEvent,
    clear_guest_progress_context,
    clear_guest_progress_sinks,
    current_progress,
    install_guest_tool_progress,
    register_guest_progress_sink,
    set_guest_progress_context,
)


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _drain(q: asyncio.Queue) -> list[dict]:
    items: list[dict] = []
    while not q.empty():
        items.append(q.get_nowait())
    return items


@pytest.mark.asyncio
async def test_mcp_progress_sink_preserves_accepted_payload_when_closed() -> None:
    queue: asyncio.Queue[dict] = asyncio.Queue()
    sink = McpProgressSink(asyncio.get_running_loop(), queue)
    payload = {"method": "notifications/progress"}

    sink.emit(payload)
    sink.close()
    await asyncio.sleep(0)

    assert queue.get_nowait() == payload
    sink.emit({"method": "late"})
    await asyncio.sleep(0)
    assert queue.empty()


def test_scrub_guest_progress_text_drops_host_paths_and_caps_length():
    assert scrub_guest_progress_text("guest_get_project") == "guest_get_project"
    assert scrub_guest_progress_text("   ") is None
    assert scrub_guest_progress_text("/Users/host/episode.wav") is None
    assert scrub_guest_progress_text("file:///tmp/x") is None
    assert scrub_guest_progress_text(r"C:\Users\host\mix.wav") is None
    assert scrub_guest_progress_text(r"\\server\share\mix.wav") is None
    assert scrub_guest_progress_text("~/episode.wav") is None
    assert (
        scrub_guest_progress_text("Render failed: /Users/host/secret.wav")
        == "Render failed: [path]"
    )
    long = "x" * 250
    out = scrub_guest_progress_text(long)
    assert out is not None
    assert len(out) == 200
    assert out.endswith("…")


def test_guest_progress_payload_has_no_host_paths():
    payload = guest_progress_payload(
        ProgressEvent(
            kind="update",
            task_id="guest_render_preview",
            label="Render preview",
            current=1,
            total=2,
            elapsed_sec=1.5,
            message="/Users/host/secret.wav",
            phase="mix",
        )
    )
    blob = json.dumps(payload)
    assert "/Users/" not in blob
    assert payload["plane"] == "progress"
    assert payload["status"] == "running"
    assert payload["message"] is None
    assert payload["task_id"] == "guest_render_preview"


def test_guest_progress_payload_terminal_status():
    assert (
        guest_progress_payload(
            ProgressEvent(
                kind="end",
                task_id="t",
                label="t",
                current=1,
                total=1,
                elapsed_sec=1,
            )
        )["status"]
        == "ok"
    )
    assert (
        guest_progress_payload(
            ProgressEvent(
                kind="fail",
                task_id="t",
                label="t",
                current=1,
                total=1,
                elapsed_sec=1,
            )
        )["status"]
        == "error"
    )
    assert (
        guest_progress_payload(
            ProgressEvent(
                kind="cancel",
                task_id="t",
                label="t",
                current=1,
                total=1,
                elapsed_sec=1,
            )
        )["status"]
        == "cancelled"
    )


@pytest.mark.asyncio
async def test_guest_hub_publishes_only_to_that_token():
    reset_guest_progress_hub()
    hub = guest_progress_hub()
    loop = asyncio.get_running_loop()
    q_a = hub.subscribe("alpha", loop)
    q_b = hub.subscribe("beta", loop)
    reporter = GuestWsProgressReporter(hub, "alpha")
    try:
        reporter.start("guest_render_preview", "Render preview", total=2)
        reporter.update(
            "guest_render_preview",
            1,
            total=2,
            message="Mixing stems",
        )
        reporter.end("guest_render_preview", message="done")
        await asyncio.sleep(0.05)
        got_a: list[dict] = []
        while not q_a.empty():
            got_a.append(q_a.get_nowait())
        assert got_a
        assert all(item.get("plane") == "progress" for item in got_a)
        assert q_b.empty()
        blob = json.dumps(got_a)
        assert "/Users/" not in blob
        assert "Mixing stems" in blob
    finally:
        reporter.close()
        hub.unsubscribe("alpha", q_a)
        hub.unsubscribe("beta", q_b)


@pytest.mark.asyncio
async def test_guest_reporter_fail_cancel_and_heartbeat_when_visible():
    reset_guest_progress_hub()
    hub = guest_progress_hub()
    loop = asyncio.get_running_loop()
    q = hub.subscribe("tok", loop)
    reporter = GuestWsProgressReporter(hub, "tok")
    try:
        reporter.update("t", 1, message="go")
        reporter.heartbeat("t", message="still working")
        reporter.fail("t", message="boom", phase="mix")
        await asyncio.sleep(0.05)
        kinds = [item["kind"] for item in _drain(q)]
        assert "update" in kinds
        assert "heartbeat" in kinds
        assert "fail" in kinds
        reporter2 = GuestWsProgressReporter(hub, "tok")
        try:
            reporter2.update("u", 1, message="go")
            reporter2.cancel("u", message="stop")
            await asyncio.sleep(0.05)
            kinds2 = [item["kind"] for item in _drain(q)]
            assert "cancel" in kinds2
        finally:
            reporter2.close()
    finally:
        reporter.close()
        hub.unsubscribe("tok", q)


@pytest.mark.asyncio
async def test_guest_reporter_instant_tool_does_not_flash():
    reset_guest_progress_hub()
    hub = guest_progress_hub()
    loop = asyncio.get_running_loop()
    q = hub.subscribe("tok", loop)
    reporter = GuestWsProgressReporter(hub, "tok")
    try:
        reporter.start("guest_get_project", "guest_get_project")
        reporter.end("guest_get_project", message="done")
        await asyncio.sleep(0.05)
        assert q.empty()
    finally:
        reporter.close()
        hub.unsubscribe("tok", q)


@pytest.mark.asyncio
async def test_guest_reporter_coalesces_updates():
    reset_guest_progress_hub()
    hub = guest_progress_hub()
    loop = asyncio.get_running_loop()
    q = hub.subscribe("tok", loop)
    reporter = GuestWsProgressReporter(hub, "tok")
    try:
        reporter.start("t", "Work", total=20)
        for i in range(1, 21):
            reporter.update("t", i, total=20, message=f"step {i}")
        reporter.end("t", message="done")
        time.sleep(0.3)
        await asyncio.sleep(0.05)
        events = []
        while not q.empty():
            events.append(q.get_nowait())
        updates = [e for e in events if e.get("kind") == "update"]
        assert 0 < len(updates) < 20
        assert any(e.get("kind") == "end" for e in events)
    finally:
        reporter.close()
        hub.unsubscribe("tok", q)


@pytest.mark.asyncio
async def test_install_guest_tool_progress_mcp_notifications_when_token_present():
    ctx = GuestMcpProgressContext("pt-1")
    set_guest_progress_context(token="share-tok", mcp_context=ctx)

    def impl(name, arguments=None):
        current_progress().update(name, 1, total=2, message="/Users/host/mix.wav")
        current_progress().end(name, message="done")
        return {"ok": True}

    try:
        wrapped = install_guest_tool_progress(impl)
        out = wrapped("guest_get_project", {})
        assert out == {"ok": True}
        await asyncio.sleep(0)
        assert ctx.notifications
        assert all(n["method"] == "notifications/progress" for n in ctx.notifications)
        assert all(n["params"]["progressToken"] == "pt-1" for n in ctx.notifications)
        blob = json.dumps(ctx.notifications)
        assert "/Users/" not in blob
        assert "mix.wav" not in blob
    finally:
        clear_guest_progress_context()


@pytest.mark.asyncio
async def test_handle_mcp_jsonrpc_progress_token_uses_guest_context(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    captured: list[GuestMcpProgressContext] = []

    class Capturing(GuestMcpProgressContext):
        def __init__(self, progressToken, sink=None):
            super().__init__(progressToken, sink=sink)
            captured.append(self)

    monkeypatch.setattr(
        "podcast_mcp.services.remote_mcp.protocol.GuestMcpProgressContext",
        Capturing,
    )
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="McpProgress")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment", "mcp"],
    )
    token = share["token"]

    def impl(name, arguments=None):
        current_progress().update(name, 1, total=2, message="Mixing stems")
        return {"ok": True}

    monkeypatch.setattr(
        "podcast_mcp.services.remote_mcp.protocol.call_tool",
        install_guest_tool_progress(impl),
    )
    out = handle_mcp_jsonrpc(
        token,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "guest_get_review_summary",
                "arguments": {},
                "_meta": {"progressToken": "pt-wire"},
            },
        },
    )
    await asyncio.sleep(0)
    assert out is not None
    assert "error" not in out
    assert captured
    assert captured[0].progressToken == "pt-wire"
    assert captured[0].notifications
    assert captured[0].notifications[0]["params"]["progressToken"] == "pt-wire"


def test_progress_ws_commenter_without_view_receives_own_events(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    workspace = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(workspace).publish(label="ProgressWS")
    share = ShareService(workspace).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment"],
    )
    token = share["token"]
    client = TestClient(create_app())
    register_guest_progress_sink(guest_ws_progress_sink)

    def impl(name, arguments=None):
        current_progress().update(name, 1, total=2, message="/Users/host/stem.wav")
        current_progress().end(name, message="done")
        return {"ok": True}

    wrapped = install_guest_tool_progress(impl)
    with client.websocket_connect(f"/api/review/{token}/progress/ws") as guest_ws:
        set_guest_progress_context(token=token)
        try:
            wrapped("guest_render_preview", {})
        finally:
            clear_guest_progress_context()
        msg = guest_ws.receive_json()
        assert msg["plane"] == "progress"
        assert msg["status"] in {"running", "ok"}
        blob = json.dumps(msg)
        assert "/Users/" not in blob
        assert "stem.wav" not in blob


def test_progress_ws_rejects_invalid_token():
    client = TestClient(create_app())
    with client.websocket_connect("/api/review/no-such-token/progress/ws") as ws:
        payload = ws.receive()
    assert payload["type"] == "websocket.close"
    assert payload["code"] == 4403


@pytest.mark.asyncio
async def test_guest_hub_unsubscribe_and_publish_without_listeners():
    reset_guest_progress_hub()
    hub = guest_progress_hub()
    loop = asyncio.get_running_loop()
    dummy: asyncio.Queue[dict] = asyncio.Queue()
    hub.unsubscribe("missing", dummy)
    hub.publish("missing", {"plane": "progress"})
    q1 = hub.subscribe("tok", loop)
    q2 = hub.subscribe("tok", loop)
    hub.unsubscribe("tok", q1)
    assert hub.listener_count("tok") == 1
    hub.unsubscribe("tok", q2)
    assert hub.listener_count("tok") == 0
    hub.publish("tok", {"plane": "progress"})


@pytest.mark.asyncio
async def test_guest_hub_drops_oldest_on_full_queue():
    reset_guest_progress_hub()
    hub = guest_progress_hub()
    loop = asyncio.get_running_loop()
    q = hub.subscribe("tok", loop)
    try:
        for i in range(64):
            q.put_nowait({"i": i})
        hub.publish("tok", {"plane": "progress", "kind": "update"})
        await asyncio.sleep(0.05)
        assert q.full()
        items = _drain(q)
        assert any(item.get("kind") == "update" for item in items)
    finally:
        hub.unsubscribe("tok", q)


@pytest.mark.asyncio
async def test_guest_hub_publish_ignores_closed_loop():
    reset_guest_progress_hub()
    hub = guest_progress_hub()
    loop = asyncio.new_event_loop()
    q = hub.subscribe("tok", loop)
    loop.close()
    hub.publish("tok", {"plane": "progress"})
    hub.unsubscribe("tok", q)


@pytest.mark.asyncio
async def test_guest_reporter_lazy_start_and_coalesce_and_message():
    reset_guest_progress_hub()
    hub = guest_progress_hub()
    loop = asyncio.get_running_loop()
    q = hub.subscribe("tok", loop)
    reporter = GuestWsProgressReporter(hub, "tok")
    try:
        reporter.start("t", "Slow work", total=4)
        await asyncio.sleep(1.1)
        events = _drain(q)
        assert any(e.get("kind") == "start" for e in events)
        reporter.message("t", "phase two")
        await asyncio.sleep(0.3)
        msg_events = _drain(q)
        assert any(e.get("kind") == "message" for e in msg_events)
        reporter.update("t", 1, total=4, message="a")
        await asyncio.sleep(0.3)
        reporter.update("t", 2, total=4, message="b")
        await asyncio.sleep(0.3)
        later = _drain(q)
        kinds = [e.get("kind") for e in later]
        assert kinds.count("update") <= 2
        reporter._on_lazy(reporter._generation)
        reporter._flush_pending(reporter._generation)
    finally:
        reporter.end("t", message="done")
        reporter.close()
        hub.unsubscribe("tok", q)


def test_clear_guest_progress_sinks_and_sink_without_listeners():
    reset_guest_progress_hub()
    clear_guest_progress_sinks()
    register_guest_progress_sink(guest_ws_progress_sink)
    sink = guest_ws_progress_sink("tok")
    assert sink is not None
    closer = getattr(sink, "close", None)
    if callable(closer):
        closer()
    clear_guest_progress_sinks()
    from podcast_mcp.util.progress import guest_progress_sinks

    assert guest_progress_sinks("tok") == []
    assert guest_progress_sinks(None) == []


def test_progress_ws_concurrency_rejected(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from podcast_mcp.services.remote_mcp.limits import (
        get_host_limiters,
        reset_host_limiters_for_tests,
    )

    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    monkeypatch.setenv("PODCAST_GUEST_WS_CONCURRENT", "1")
    reset_host_limiters_for_tests()
    workspace = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(workspace).publish(label="ProgressGate")
    share = ShareService(workspace).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment"],
    )
    token = share["token"]
    lim = get_host_limiters()
    held = 0
    while lim.guest_ws_concurrent.try_enter(token).allowed:
        held += 1
        if held > 64:
            break
    client = TestClient(create_app())
    try:
        with client.websocket_connect(f"/api/review/{token}/progress/ws") as guest_ws:
            payload = guest_ws.receive()
            assert payload["type"] == "websocket.close"
            assert payload["code"] == 4429
    finally:
        for _ in range(held):
            lim.guest_ws_concurrent.exit(token)


def test_share_progress_still_valid_without_view(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from unittest.mock import MagicMock

    from podcast_mcp.gui.routes.review_share import (
        _share_progress_still_valid,
        _share_token_present,
    )

    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    workspace = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(workspace).publish(label="Present")
    share = ShareService(workspace).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment"],
    )
    token = share["token"]
    assert _share_token_present(token) is True
    assert _share_token_present("missing-token-xyz") is False
    ws = MagicMock()
    assert _share_progress_still_valid(token, restricted=False, websocket=ws) is True
    assert _share_progress_still_valid("missing-token-xyz", restricted=False, websocket=ws) is False


def _sse_payloads(text: str) -> list[dict]:
    out: list[dict] = []
    for block in text.split("\n\n"):
        data = [ln[5:].strip() for ln in block.splitlines() if ln.startswith("data:")]
        if not data:
            continue
        out.append(json.loads("\n".join(data)))
    return out


def test_mcp_progress_token_streams_sse_notifications(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="SseProgress")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment", "mcp"],
    )
    token = share["token"]

    def impl(name, arguments=None):
        current_progress().update(name, 1, total=2, message="Mixing stems")
        current_progress().end(name, message="done")
        return {"ok": True}

    monkeypatch.setattr(
        "podcast_mcp.services.remote_mcp.protocol.call_tool",
        install_guest_tool_progress(impl),
    )
    client = TestClient(create_app())
    resp = client.post(
        f"/mcp/{token}/mcp",
        headers={"Accept": "application/json, text/event-stream"},
        json={
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/call",
            "params": {
                "name": "guest_get_review_summary",
                "arguments": {},
                "_meta": {"progressToken": "pt-sse"},
            },
        },
    )
    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers["content-type"]
    payloads = _sse_payloads(resp.text)
    notes = [p for p in payloads if p.get("method") == "notifications/progress"]
    results = [p for p in payloads if "result" in p]
    assert notes
    assert all(n["params"]["progressToken"] == "pt-sse" for n in notes)
    assert results
    assert payloads.index(notes[0]) < payloads.index(results[0])
    blob = json.dumps(payloads)
    assert "/Users/" not in blob


def test_progress_ws_isolates_two_share_tokens(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    workspace = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(workspace).publish(label="DualTok")
    share_a = ShareService(workspace).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment"],
    )
    share_b = ShareService(workspace).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment"],
    )
    tok_a, tok_b = share_a["token"], share_b["token"]
    client = TestClient(create_app())
    register_guest_progress_sink(guest_ws_progress_sink)

    def impl_a(name, arguments=None):
        current_progress().update(name, 1, total=2, message="alpha-only")
        current_progress().end(name, message="done")
        return {"ok": True}

    def impl_b(name, arguments=None):
        current_progress().update(name, 1, total=2, message="beta-only")
        current_progress().end(name, message="done")
        return {"ok": True}

    with client.websocket_connect(f"/api/review/{tok_a}/progress/ws") as ws_a:
        with client.websocket_connect(f"/api/review/{tok_b}/progress/ws") as ws_b:
            set_guest_progress_context(token=tok_a)
            try:
                install_guest_tool_progress(impl_a)("guest_render_preview", {})
            finally:
                clear_guest_progress_context()
            msg_a = ws_a.receive_json()
            assert "alpha-only" in json.dumps(msg_a)
            set_guest_progress_context(token=tok_b)
            try:
                install_guest_tool_progress(impl_b)("guest_render_preview", {})
            finally:
                clear_guest_progress_context()
            msg_b = ws_b.receive_json()
            blob_b = json.dumps(msg_b)
            assert "beta-only" in blob_b
            assert "alpha-only" not in blob_b


@pytest.mark.asyncio
async def test_guest_hub_keeps_terminal_on_overflow():
    reset_guest_progress_hub()
    hub = guest_progress_hub()
    loop = asyncio.get_running_loop()
    q = hub.subscribe("tok", loop)
    try:
        for i in range(64):
            q.put_nowait({"kind": "update", "task_id": "t", "i": i, "status": "running"})
        hub.publish("tok", {"kind": "end", "task_id": "t", "status": "ok", "plane": "progress"})
        await asyncio.sleep(0.05)
        items = _drain(q)
        assert any(item.get("kind") == "end" for item in items)
    finally:
        hub.unsubscribe("tok", q)


@pytest.mark.asyncio
async def test_guest_hub_replays_last_running_on_subscribe():
    reset_guest_progress_hub()
    hub = guest_progress_hub()
    loop = asyncio.get_running_loop()
    hub.publish("tok", {"kind": "update", "task_id": "t", "status": "running", "message": "late"})
    q = hub.subscribe("tok", loop)
    try:
        items = _drain(q)
        assert items
        assert items[0]["message"] == "late"
    finally:
        hub.unsubscribe("tok", q)


@pytest.mark.asyncio
async def test_guest_reporter_ignores_timer_after_terminal():
    reset_guest_progress_hub()
    hub = guest_progress_hub()
    loop = asyncio.get_running_loop()
    q = hub.subscribe("tok", loop)
    reporter = GuestWsProgressReporter(hub, "tok")
    try:
        reporter.update("t", 1, message="go")
        stale_gen = reporter._generation
        reporter.fail("t", message="boom")
        await asyncio.sleep(0.05)
        _drain(q)
        reporter._flush_pending(stale_gen)
        reporter._on_lazy(stale_gen)
        await asyncio.sleep(0.05)
        leftover = _drain(q)
        assert leftover == []
    finally:
        reporter.close()
        hub.unsubscribe("tok", q)


@pytest.mark.asyncio
async def test_guest_reporter_heartbeat_mixin_emits():
    reset_guest_progress_hub()
    hub = guest_progress_hub()
    loop = asyncio.get_running_loop()
    q = hub.subscribe("tok", loop)
    reporter = GuestWsProgressReporter(hub, "tok", heartbeat_sec=0.15)
    try:
        reporter.update("t", 1, message="go")
        time.sleep(1.3)
        await asyncio.sleep(0.05)
        kinds = [item["kind"] for item in _drain(q)]
        assert "heartbeat" in kinds
    finally:
        reporter.close()
        hub.unsubscribe("tok", q)


@pytest.mark.asyncio
async def test_guest_reporter_fail_strips_traceback():
    reset_guest_progress_hub()
    hub = guest_progress_hub()
    loop = asyncio.get_running_loop()
    q = hub.subscribe("tok", loop)
    reporter = GuestWsProgressReporter(hub, "tok")
    try:
        reporter.update("t", 1, message="go")
        reporter.fail(
            "t",
            message="Traceback (most recent call last):\n  File",
            phase="mix",
        )
        await asyncio.sleep(0.05)
        fail = next(item for item in _drain(q) if item.get("kind") == "fail")
        assert fail["status"] == "error"
        assert fail["message"] == "mix"
    finally:
        reporter.close()
        hub.unsubscribe("tok", q)
