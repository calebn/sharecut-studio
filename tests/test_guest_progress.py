"""Guest progress hub, MCP notifications, and review-share WS isolation."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.guest_progress import (
    GUEST_PROGRESS_COALESCE_SEC,
    GUEST_PROGRESS_MAX_HZ,
    GuestWsProgressReporter,
    guest_progress_hub,
    guest_progress_payload,
    guest_ws_progress_sink,
    reset_guest_progress_hub,
    scrub_guest_progress_text,
)
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.remote_mcp.progress import (
    GuestMcpProgressContext,
    McpProgressSink,
)
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.util import progress as progress_mod
from podcast_mcp.util.progress import (
    PROGRESS_UPDATE_MIN_INTERVAL_SEC,
    ProgressEvent,
    clear_guest_progress_context,
    clear_guest_progress_sinks,
    current_progress,
    install_guest_tool_progress,
    progress_task,
    register_guest_progress_sink,
    set_guest_progress_context,
)
from podcast_mcp.util.tool_refusal import guest_failure_detail
from sync_helpers import drain


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def test_guest_coalesce_matches_source_cadence():
    assert GUEST_PROGRESS_COALESCE_SEC == PROGRESS_UPDATE_MIN_INTERVAL_SEC
    assert GUEST_PROGRESS_MAX_HZ == 4


@pytest.mark.asyncio
async def test_throttled_task_final_value_reaches_guest_ws_before_end(monkeypatch):
    monkeypatch.setattr(progress_mod, "_update_clock", lambda: 0.0)  # source throttle frozen
    reset_guest_progress_hub()
    hub = guest_progress_hub()
    q = hub.subscribe("tok", asyncio.get_running_loop())
    reporter = GuestWsProgressReporter(hub, "tok")
    try:
        with progress_task("t", "Work", total=100, reporter=reporter) as p:
            for _ in range(20):
                p.advance(1, message="working")
        await asyncio.sleep(0.05)
        events = drain(q)
        kinds = [e.get("kind") for e in events]
        assert kinds[-1] == "end"
        updates = [e for e in events if e.get("kind") == "update"]
        assert updates[-1]["current"] == 20
        assert updates[-1]["total"] == 100
        assert kinds.index("end") > max(i for i, k in enumerate(kinds) if k == "update")
    finally:
        reporter.close()
        hub.unsubscribe("tok", q)


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
        kinds = [item["kind"] for item in drain(q)]
        assert "update" in kinds
        assert "heartbeat" in kinds
        assert "fail" in kinds
        reporter2 = GuestWsProgressReporter(hub, "tok")
        try:
            reporter2.update("u", 1, message="go")
            reporter2.cancel("u", message="stop")
            await asyncio.sleep(0.05)
            kinds2 = [item["kind"] for item in drain(q)]
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
        wrapped = install_guest_tool_progress(impl, fail_detail=guest_failure_detail)
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
        install_guest_tool_progress(impl, fail_detail=guest_failure_detail),
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


def _next_progress_frame(socket, *, limit: int = 40) -> dict:
    """Read daw/ws frames until the progress plane delivers one."""
    for _ in range(limit):
        frame = socket.receive_json()
        if frame.get("plane") == "progress":
            return frame
    raise AssertionError("no progress frame on the guest socket")


def test_daw_ws_forwards_scrubbed_guest_progress_for_its_own_token(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    workspace = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(workspace).publish(label="ProgressWS")
    share = ShareService(workspace).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    token = share["token"]
    client = TestClient(create_app())
    register_guest_progress_sink(guest_ws_progress_sink)

    def impl(name, arguments=None):
        current_progress().update(name, 1, total=2, message="/Users/host/stem.wav")
        current_progress().end(name, message="done")
        return {"ok": True}

    wrapped = install_guest_tool_progress(impl, fail_detail=guest_failure_detail)
    with client.websocket_connect(f"/api/review/{token}/daw/ws") as guest_ws:
        set_guest_progress_context(token=token)
        try:
            wrapped("guest_render_preview", {})
        finally:
            clear_guest_progress_context()
        msg = _next_progress_frame(guest_ws)
        assert msg["status"] in {"running", "ok"}
        blob = json.dumps(msg)
        assert "/Users/" not in blob
        assert "stem.wav" not in blob


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
        items = drain(q)
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
        events = drain(q)
        assert any(e.get("kind") == "start" for e in events)
        reporter.message("t", "phase two")
        await asyncio.sleep(0.3)
        msg_events = drain(q)
        assert any(e.get("kind") == "message" for e in msg_events)
        reporter.update("t", 1, total=4, message="a")
        await asyncio.sleep(0.3)
        reporter.update("t", 2, total=4, message="b")
        await asyncio.sleep(0.3)
        later = drain(q)
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
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="SseProgress")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "comment", "mcp"],
    )
    token = share["token"]
    impl_threads: list[str] = []

    def impl(name, arguments=None):
        impl_threads.append(threading.current_thread().name)
        current_progress().update(name, 1, total=2, message="Mixing stems")
        current_progress().end(name, message="done")
        return {"ok": True}

    monkeypatch.setattr(
        "podcast_mcp.services.remote_mcp.protocol.call_tool",
        install_guest_tool_progress(impl, fail_detail=guest_failure_detail),
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
    assert impl_threads and impl_threads[0].startswith("guest-mcp")
    assert payloads.index(notes[0]) < payloads.index(results[0])
    blob = json.dumps(payloads)
    assert "/Users/" not in blob


def test_daw_ws_isolates_guest_progress_between_two_share_tokens(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    workspace = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(workspace).publish(label="DualTok")
    share_a = ShareService(workspace).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    share_b = ShareService(workspace).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
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

    with client.websocket_connect(f"/api/review/{tok_a}/daw/ws") as ws_a:
        with client.websocket_connect(f"/api/review/{tok_b}/daw/ws") as ws_b:
            set_guest_progress_context(token=tok_a)
            try:
                install_guest_tool_progress(impl_a, fail_detail=guest_failure_detail)(
                    "guest_render_preview", {}
                )
            finally:
                clear_guest_progress_context()
            msg_a = _next_progress_frame(ws_a)
            assert "alpha-only" in json.dumps(msg_a)
            set_guest_progress_context(token=tok_b)
            try:
                install_guest_tool_progress(impl_b, fail_detail=guest_failure_detail)(
                    "guest_render_preview", {}
                )
            finally:
                clear_guest_progress_context()
            msg_b = _next_progress_frame(ws_b)
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
        items = drain(q)
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
        items = drain(q)
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
        drain(q)
        reporter._flush_pending(stale_gen)
        reporter._on_lazy(stale_gen)
        await asyncio.sleep(0.05)
        leftover = drain(q)
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
        kinds = [item["kind"] for item in drain(q)]
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
        fail = next(item for item in drain(q) if item.get("kind") == "fail")
        assert fail["status"] == "error"
        assert fail["message"] == "mix"
    finally:
        reporter.close()
        hub.unsubscribe("tok", q)


_CRASH_TEXT = "ffmpeg exploded reading /Users/host/Podcasts/Secret Show/raw.wav (internal_helper)"


def _guest_share(minimal_project, sample_wav, monkeypatch, label: str) -> str:
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label=label)
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view", "comment", "mcp"],
    )
    return share["token"]


def _failing_guest_tool(monkeypatch, exc: BaseException) -> None:
    """Replace ``guest_get_project`` with a handler whose progress task fails on ``exc``."""
    from podcast_mcp.services.remote_mcp import tools as rt

    def handler():
        with progress_task("guest_get_project", "Rendering preview", total=2) as task:
            task.advance(1, message="working")
            raise exc

    monkeypatch.setattr(rt, "TOOL_HANDLERS", {**rt.TOOL_HANDLERS, "guest_get_project": handler})


def _guest_call(token: str, progress_token: str | None = None) -> dict:
    params: dict = {"name": "guest_get_project", "arguments": {}}
    if progress_token is not None:
        params["_meta"] = {"progressToken": progress_token}
    out = handle_mcp_jsonrpc(
        token, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": params}
    )
    assert out is not None
    return out


@pytest.mark.parametrize(
    "exc",
    [
        OSError(2, "No such file", "/Users/host/Podcasts/Secret Show/raw.wav"),
        ValueError(_CRASH_TEXT),
        KeyError("internal_helper"),
        RuntimeError(_CRASH_TEXT),
    ],
    ids=["os", "value", "key", "runtime"],
)
def test_guest_mcp_progress_for_a_crash_names_the_task_not_the_exception(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, exc
):
    token = _guest_share(minimal_project, sample_wav, monkeypatch, "CrashProgress")
    captured: list[GuestMcpProgressContext] = []

    class Capturing(GuestMcpProgressContext):
        def __init__(self, progressToken, sink=None):
            super().__init__(progressToken, sink=sink)
            captured.append(self)

    monkeypatch.setattr(
        "podcast_mcp.services.remote_mcp.protocol.GuestMcpProgressContext", Capturing
    )
    _failing_guest_tool(monkeypatch, exc)

    out = _guest_call(token, progress_token="pt-crash")

    assert out["result"]["content"][0]["text"] == "Error executing tool guest_get_project"
    messages = [n["params"]["message"] for n in captured[0].notifications]
    assert messages[-2:] == ["Rendering preview failed", "guest_get_project failed"]
    blob = json.dumps(captured[0].notifications)
    for leaked in ("exploded", "internal_helper", "Secret", "raw.wav", "No such file", "/Users"):
        assert leaked not in blob


def test_guest_mcp_progress_for_a_refusal_carries_its_message_with_paths_redacted(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.util.coded_error import CodedValueError

    token = _guest_share(minimal_project, sample_wav, monkeypatch, "RefusalProgress")
    captured: list[GuestMcpProgressContext] = []

    class Capturing(GuestMcpProgressContext):
        def __init__(self, progressToken, sink=None):
            super().__init__(progressToken, sink=sink)
            captured.append(self)

    monkeypatch.setattr(
        "podcast_mcp.services.remote_mcp.protocol.GuestMcpProgressContext", Capturing
    )
    _failing_guest_tool(
        monkeypatch, CodedValueError("empty window in /Users/host/ep/raw.wav", code="invalid_range")
    )

    out = _guest_call(token, progress_token="pt-refusal")

    assert out["result"]["structuredContent"]["error_code"] == "invalid_range"
    messages = [n["params"]["message"] for n in captured[0].notifications]
    assert messages[-2:] == [
        "Rendering preview failed: empty window in [path]",
        "guest_get_project failed: empty window in [path]",
    ]


def test_guest_share_page_progress_for_a_crash_names_the_task_not_the_exception(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    token = _guest_share(minimal_project, sample_wav, monkeypatch, "CrashWs")
    register_guest_progress_sink(guest_ws_progress_sink)
    _failing_guest_tool(monkeypatch, RuntimeError(_CRASH_TEXT))
    client = TestClient(create_app())

    with client.websocket_connect(f"/api/review/{token}/daw/ws") as guest_ws:
        _guest_call(token)
        frames = []
        while True:
            frame = _next_progress_frame(guest_ws)
            frames.append(frame)
            if frame["status"] == "error":
                break

    assert [f["message"] for f in frames if f["status"] == "error"] == ["Rendering preview failed"]
    blob = json.dumps(frames)
    for leaked in ("exploded", "internal_helper", "Secret", "raw.wav", "/Users"):
        assert leaked not in blob


def test_progress_task_outside_a_guest_call_keeps_the_exception_text():
    rec = progress_mod.RecordingProgress()
    with pytest.raises(RuntimeError):
        with progress_task("t", "Work", reporter=rec):
            raise RuntimeError("disk is full")

    fails = [e for e in rec.events if e.kind == "fail"]
    assert fails[-1].message == "Work failed: disk is full"
