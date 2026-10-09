"""Capability-scoped remote MCP allowlist + JSON-RPC bridge tests."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.edits.share_capabilities import capabilities_for_role
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools import guest as guest_tools_pkg
from podcast_mcp.models import (
    Clip,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.document_sync.capabilities import (
    document_command_types_for_caps,
)
from podcast_mcp.services.remote_mcp.allowlist import (
    tool_allowed,
    tools_for_capabilities,
)
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _share(ws, monkeypatch, tmp_workspace, caps: list[str], label: str = "mcp"):
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    ver = ReviewService(ws).publish(label=label)
    return ShareService(ws).create(
        review_version_id=ver["id"],
        public_base_url="https://share.example",
        capabilities=caps,
    )


def _call(token: str, name: str, arguments: dict | None = None, req_id: int = 1):
    return handle_mcp_jsonrpc(
        token,
        {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}},
        },
    )


def test_tools_for_capabilities_matrix() -> None:
    assert hasattr(guest_tools_pkg, "__all__")

    view = tools_for_capabilities(["play", "view", "mcp"])
    assert "guest_get_project" in view
    assert "guest_get_session_presence" in view
    assert "guest_pending_preview" in view
    assert "guest_audition_context" in view
    assert "guest_add_comment" not in view
    assert "guest_submit_document_command" not in view

    comment = tools_for_capabilities(["play", "comment", "mcp"])
    assert "guest_add_comment" in comment
    assert "guest_get_project" not in comment
    assert "guest_get_session_presence" not in comment
    assert "guest_pending_preview" not in comment
    assert "guest_get_review_summary" in comment

    suggest = tools_for_capabilities(capabilities_for_role("commenter", with_mcp=True))
    assert "guest_submit_document_command" in suggest
    assert tool_allowed(
        capabilities_for_role("commenter", with_mcp=True), "guest_submit_document_command"
    )

    edit = tools_for_capabilities(capabilities_for_role("editor", with_mcp=True))
    assert "guest_submit_document_command" in edit
    assert "guest_render_preview" in edit
    assert "guest_upload_media" in edit
    assert "guest_render_preview" not in suggest
    assert "guest_upload_media" not in view

    assert tools_for_capabilities([]) == frozenset()
    assert tools_for_capabilities(["mcp"]) == frozenset()
    assert "ApproveEdits" in document_command_types_for_caps(capabilities_for_role("editor"))
    assert "SuggestPendingEdit" in document_command_types_for_caps(
        capabilities_for_role("commenter")
    )
    assert "SplitAtTime" in document_command_types_for_caps(capabilities_for_role("editor"))
    assert "SplitAtTime" in document_command_types_for_caps(capabilities_for_role("commenter"))
    assert document_command_types_for_caps(["suggest", "edit"]) == frozenset()
    assert document_command_types_for_caps(["play"]) == frozenset()


def test_handle_mcp_jsonrpc_filters_tools(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"])
    token = share["token"]

    init = handle_mcp_jsonrpc(
        token,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "0"},
            },
        },
    )
    assert init and init["result"]["serverInfo"]["name"] == "podcast-guest-mcp"

    listed = handle_mcp_jsonrpc(
        token, {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
    )
    names = {t["name"] for t in listed["result"]["tools"]}
    assert "guest_get_project" in names
    assert "guest_audition_context" in names
    assert "guest_add_comment" not in names
    assert "pipeline_run" not in names

    called = _call(token, "guest_get_project", req_id=3)
    text = called["result"]["content"][0]["text"]
    payload = json.loads(text)
    assert payload.get("project_path") == ""
    assert "/Users/" not in text

    presence = _call(token, "guest_get_session_presence", req_id=31)
    presence_text = presence["result"]["content"][0]["text"]
    presence_payload = json.loads(presence_text)
    assert "clients" in presence_payload
    assert "/Users/" not in presence_text

    denied = _call(
        token,
        "guest_add_comment",
        {"body": "x", "author": "a", "timeline_start": 0.0},
        req_id=4,
    )
    assert "error" in denied
    assert "share capabilities do not allow tool" in denied["error"]["message"]

    denied_empty = _call(token, "guest_add_comment", {}, req_id=5)
    assert "error" in denied_empty
    assert "share capabilities do not allow tool" in denied_empty["error"]["message"]
    assert "missing" not in denied_empty["error"]["message"].lower()


def test_guest_list_clips_names_no_recording_file(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    ws.project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=60.0),
        )
    ]
    ws.project.sources = [SourceRecording(id="take2", path="raw/take2.wav", duration_sec=30.0)]
    ws.project.timeline.clips = [
        Clip(id="a", track_id="host", source_start=0.0, source_end=5.0, timeline_start=0.0),
        Clip(id="b", track_id="host", source_start=5.0, source_end=9.0, timeline_start=5.0),
        Clip(
            id="c",
            track_id="host",
            source_id="take2",
            source_start=0.0,
            source_end=4.0,
            timeline_start=9.0,
        ),
    ]
    ws.save()
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"])

    text = _call(share["token"], "guest_list_clips")["result"]["content"][0]["text"]
    repeated_text = _call(share["token"], "guest_list_clips")["result"]["content"][0]["text"]

    rows = {row["id"]: row for row in json.loads(text)["tracks"]["host"]}
    key = rows["a"]["recording_key"]
    assert re.fullmatch(r"rec_[0-9a-f]{16}", key)
    guessed_seed = f"{ws.project.workspace_path().resolve()}\0raw/host.wav"
    guessed_key = f"rec_{hashlib.sha256(guessed_seed.encode()).hexdigest()[:16]}"
    assert key != guessed_key, "Guest key confirms a guessed recording path without a server secret"
    assert rows["b"]["recording_key"] == key
    assert rows["c"]["recording_key"] != key
    repeated_rows = {row["id"]: row for row in json.loads(repeated_text)["tracks"]["host"]}
    assert repeated_rows["a"]["recording_key"] == key
    assert ".wav" not in text
    assert "raw/" not in text


def test_guest_tool_surface_and_protocol_edges(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    caps = [
        "play",
        "view",
        "comment",
        "reply",
        "action",
        "suggest",
        "edit",
        "mcp",
    ]
    share = _share(ws, monkeypatch, tmp_workspace, caps, label="mcp-full")
    token = share["token"]

    assert (
        handle_mcp_jsonrpc(
            token,
            {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
        )
        is None
    )

    ping = handle_mcp_jsonrpc(token, {"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}})
    assert ping and "result" in ping

    unknown = handle_mcp_jsonrpc(token, {"jsonrpc": "2.0", "id": 2, "method": "nope", "params": {}})
    assert unknown["error"]["code"] == -32601

    # Non-dict arguments that are truthy (empty list is falsy and becomes {}).
    bad_args = handle_mcp_jsonrpc(
        token,
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "guest_get_project", "arguments": ["nope"]},
        },
    )
    assert bad_args["error"]["code"] == -32602

    missing = _call(token, "guest_get_review_summary", {}, req_id=4)
    wrong = _call(token, "guest_search_transcript", {}, req_id=5)
    assert "error" in wrong
    assert wrong["error"]["code"] == -32602

    unknown_tool = _call(token, "pipeline_run", {}, req_id=6)
    assert unknown_tool["error"]["code"] == -32602

    assert "error" not in missing
    assert "error" not in _call(token, "guest_audio_info", req_id=7)
    assert "error" not in _call(token, "guest_list_clips", req_id=8)
    assert "error" not in _call(token, "guest_list_pending_edits", req_id=9)
    assert "error" not in _call(token, "guest_list_applied_edits", req_id=10)
    assert "error" not in _call(token, "guest_render_status", req_id=11)
    assert "error" not in _call(token, "guest_list_comments", req_id=12)
    assert "error" not in _call(
        token, "guest_search_transcript", {"query": "the", "limit": 3}, req_id=13
    )

    added = _call(
        token,
        "guest_add_comment",
        {
            "body": "mcp test",
            "author": "tester",
            "timeline_start": 0.5,
            "timeline_end": 1.0,
        },
        req_id=14,
    )
    assert "error" not in added
    comment = json.loads(added["result"]["content"][0]["text"])["comment"]
    cid = comment["id"]

    replied = _call(
        token,
        "guest_add_reply",
        {"comment_id": cid, "body": "ok", "author": "tester"},
        req_id=15,
    )
    assert "error" not in replied

    action = _call(
        token,
        "guest_set_action_done",
        {"comment_id": cid, "action_id": "missing", "done": True},
        req_id=16,
    )
    assert action["result"]["isError"] is True
    assert action["result"]["structuredContent"]["error_code"] == "action_item_not_found"

    suggest = _call(
        token,
        "guest_submit_document_command",
        {
            "type": "SuggestPendingEdit",
            "payload": {
                "track_id": "host",
                "start": 0.1,
                "end": 0.2,
                "reason": "coverage",
            },
        },
        req_id=17,
    )
    smsg = str((suggest.get("error") or {}).get("message") or "")
    assert "do not allow document command" not in smsg.lower()
    assert "do not allow tool" not in smsg.lower()

    approve = _call(
        token,
        "guest_submit_document_command",
        {"type": "ApproveEdits", "payload": {"ids": []}},
        req_id=18,
    )
    amsg = str((approve.get("error") or {}).get("message") or "")
    assert "do not allow document command" not in amsg.lower()

    no_mcp = handle_mcp_jsonrpc(
        "not-a-real-token",
        {"jsonrpc": "2.0", "id": 99, "method": "ping", "params": {}},
    )
    assert "error" in no_mcp


def test_suggest_only_denies_approve(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(
        ws,
        monkeypatch,
        tmp_workspace,
        capabilities_for_role("commenter", with_mcp=True),
        label="sug",
    )
    token = share["token"]
    denied = _call(
        token,
        "guest_submit_document_command",
        {"type": "ApproveEdits", "payload": {"ids": []}},
    )
    assert "error" in denied
    assert "do not allow document command" in denied["error"]["message"].lower()


def test_remote_mcp_http_bridge(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "comment", "mcp"], label="mcp-http")
    assert share["mcp_url"] == f"https://share.example/mcp/{share['token']}/mcp"

    client = TestClient(create_app())
    info = client.get(f"/mcp/{share['token']}")
    assert info.status_code == 200
    assert info.json()["remote_mcp_enabled"] is True
    assert info.json()["mcp_path"] == f"/mcp/{share['token']}/mcp"
    assert info.json()["mcp_alias_path"] == f"/r/{share['token']}/mcp"

    init = client.post(
        f"/mcp/{share['token']}/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "t", "version": "0"},
            },
        },
    )
    assert init.status_code == 200
    assert init.json()["result"]["capabilities"]["tools"]["listChanged"] is False

    tools = client.post(
        f"/mcp/{share['token']}/mcp",
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    )
    names = {t["name"] for t in tools.json()["result"]["tools"]}
    assert "guest_add_comment" in names
    assert "guest_get_project" not in names

    ver = ReviewService(ws).publish(label="no-mcp")
    bare = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    forbidden = client.get(f"/mcp/{bare['token']}")
    assert forbidden.status_code == 403


def test_remote_mcp_http_bridge_runs_jsonrpc_off_the_event_loop(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    import asyncio
    import threading

    from podcast_mcp.gui.routes import remote_mcp as remote_mcp_routes

    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "comment", "mcp"], label="mcp-thread")
    real = remote_mcp_routes.handle_mcp_jsonrpc
    on_loop: list[bool] = []
    threads: list[str] = []

    def spy(token, body, **kwargs):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            on_loop.append(False)
        else:
            on_loop.append(True)
        threads.append(threading.current_thread().name)
        return real(token, body, **kwargs)

    monkeypatch.setattr(remote_mcp_routes, "handle_mcp_jsonrpc", spy)
    client = TestClient(create_app())
    res = client.post(
        f"/mcp/{share['token']}/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}},
    )
    assert res.status_code == 200
    assert on_loop == [False]
    assert threads and threads[0].startswith("guest-mcp")


def test_claude_authless_handshake_and_share_alias(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    """Claude.ai custom connectors: authless Accept + /r/{token}/mcp alias."""
    from podcast_mcp.gui.routes.remote_mcp import accept_allows_json_rpc
    from podcast_mcp.services.remote_mcp.protocol import negotiate_protocol_version

    assert accept_allows_json_rpc("application/json, text/event-stream")
    assert accept_allows_json_rpc("text/event-stream")
    assert not accept_allows_json_rpc("text/plain")
    assert negotiate_protocol_version("2025-06-18") == "2025-06-18"
    assert negotiate_protocol_version("2099-01-01") == "2024-11-05"

    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"], label="claude")
    token = share["token"]
    client = TestClient(create_app())
    alias = f"/r/{token}/mcp"
    canonical = f"/mcp/{token}/mcp"

    opts = client.options(alias)
    assert opts.status_code == 204
    assert "Authorization" in opts.headers.get("access-control-allow-headers", "")

    # No Authorization header - link share authless
    init = client.post(
        alias,
        headers={"Accept": "application/json, text/event-stream"},
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "claude", "version": "0"},
            },
        },
    )
    assert init.status_code == 200
    assert init.json()["result"]["protocolVersion"] == "2025-03-26"

    # Printed MCP URL path must work on the host GUI (not relay-only).
    public_init = client.post(
        canonical,
        headers={"Accept": "application/json"},
        json={
            "jsonrpc": "2.0",
            "id": 10,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "cursor", "version": "0"},
            },
        },
    )
    assert public_init.status_code == 200
    assert public_init.json()["result"]["serverInfo"]["name"] == "podcast-guest-mcp"
    assert client.get(f"/mcp/{token}").status_code == 200
    assert client.get(f"/mcp/{token}").json()["mcp_path"] == canonical

    tools = client.post(
        canonical,
        headers={"Accept": "application/json, text/event-stream"},
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    )
    assert tools.status_code == 200
    names = {t["name"] for t in tools.json()["result"]["tools"]}
    assert "guest_get_project" in names


def test_remote_mcp_disabled_returns_501(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    monkeypatch.delenv("PODCAST_REMOTE_MCP", raising=False)
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="mcp-off")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "mcp"],
    )
    client = TestClient(create_app())
    r = client.post(
        f"/mcp/{share['token']}/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}},
    )
    assert r.status_code == 501


def test_remote_mcp_http_edge_cases(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"], label="edges")
    token = share["token"]
    client = TestClient(create_app())
    path = f"/mcp/{token}/mcp"

    assert client.options(path).status_code == 204
    assert client.get(path).status_code == 200

    bad_accept = client.post(
        path,
        json={"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}},
        headers={"Accept": "text/plain"},
    )
    assert bad_accept.status_code == 406

    assert (
        client.post(
            path, content=b"not-json", headers={"Content-Type": "application/json"}
        ).status_code
        == 400
    )
    assert client.post(path, json=[1, 2, 3]).status_code == 400

    note = client.post(
        path,
        json={"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
    )
    assert note.status_code == 202

    missing = client.get("/mcp/does-not-exist-token")
    assert missing.status_code in (403, 404)


def test_remote_mcp_context_helpers(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from podcast_mcp.services.remote_mcp.context import (
        clear_remote_mcp_context,
        get_remote_mcp_context,
        resolve_remote_mcp_context,
        set_remote_mcp_context,
    )

    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"], label="ctx")
    ctx = resolve_remote_mcp_context(share["token"])
    assert ctx.project_path.endswith("episode.project.json") or "episode" in ctx.project_path
    set_remote_mcp_context(ctx)
    assert get_remote_mcp_context() is ctx
    clear_remote_mcp_context()
    try:
        get_remote_mcp_context()
        raise AssertionError("expected RuntimeError")
    except RuntimeError:
        pass

    ver = ReviewService(ws).publish(label="no-mcp-ctx")
    bare = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    denied = handle_mcp_jsonrpc(
        bare["token"],
        {"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {}},
    )
    assert denied["error"]["code"] == -32003


def test_guest_applied_edits_shapes(monkeypatch):
    from podcast_mcp.services.remote_mcp import tools as rt

    monkeypatch.setattr(rt, "guest_get_project", lambda: {"applied_edits": {"a": 1}})
    monkeypatch.setattr(rt, "_require_tool", lambda _n: None)
    assert rt.guest_list_applied_edits() == {"a": 1}

    monkeypatch.setattr(rt, "guest_get_project", lambda: {"applied_edits": [1, 2]})
    assert rt.guest_list_applied_edits() == [1, 2]

    monkeypatch.setattr(rt, "guest_get_project", lambda: {"applied_edits": "x"})
    assert rt.guest_list_applied_edits() == {}

    monkeypatch.setattr(rt, "TOOL_HANDLERS", {**rt.TOOL_HANDLERS, "guest_ping": lambda: "pong"})
    assert rt.call_tool("guest_ping", {}) == "pong"

    class Hit:
        def model_dump(self):
            return {"text": "hi", "project_path": "/Users/secret"}

    monkeypatch.setattr(
        "podcast_mcp.edits.transcript_cuts.search_transcript",
        lambda *_a, **_k: [Hit(), {"text": "dict", "project_path": "/x"}, "plain"],
    )
    monkeypatch.setattr(
        rt,
        "get_remote_mcp_context",
        lambda: type(
            "C",
            (),
            {
                "capabilities": ["view"],
                "workspace": type("W", (), {"project": object()})(),
            },
        )(),
    )
    rows = rt.guest_search_transcript("hi", limit=10)
    assert rows[0]["text"] == "hi"
    assert "project_path" not in rows[0]
    assert rows[2]["text"] == "plain"


_HOST_SECRET = "/Users/host/private/episode/raw/host.wav"


def _raising_tool(monkeypatch, exc: BaseException, name: str = "guest_get_project") -> None:
    """Replace one guest tool with a handler that raises ``exc``."""
    from podcast_mcp.services.remote_mcp import tools as rt

    def _raise():
        raise exc

    monkeypatch.setattr(rt, "TOOL_HANDLERS", {**rt.TOOL_HANDLERS, name: _raise})


def _tool_error(out: dict) -> tuple[str, dict | None]:
    """A tool-level failure: an ``isError`` result, never a JSON-RPC protocol error."""
    assert "error" not in out, out
    result = out["result"]
    assert result["isError"] is True
    texts = [c["text"] for c in result["content"]]
    assert len(texts) == 1
    return texts[0], result.get("structuredContent")


@pytest.mark.parametrize(
    "exc",
    [
        ValueError(f"boom at {_HOST_SECRET}"),
        KeyError(_HOST_SECRET),
        TypeError("_internal_helper() missing 1 required positional argument: 'x'"),
        RuntimeError(f"ffmpeg failed reading {_HOST_SECRET}"),
        PermissionError(13, "Permission denied", _HOST_SECRET),
    ],
    ids=["value", "key", "type", "runtime", "os-permission"],
)
def test_guest_tool_crash_is_generic_and_logged_on_the_host(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, caplog, exc
):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"], label="boom")
    _raising_tool(monkeypatch, exc)

    with caplog.at_level("ERROR", logger="podcast_mcp.services.remote_mcp.protocol"):
        out = _call(share["token"], "guest_get_project", {})

    text, structured = _tool_error(out)
    assert text == "Error executing tool guest_get_project"
    assert structured is None
    assert "/Users/host" not in json.dumps(out)
    assert "_internal_helper" not in json.dumps(out)
    logged = [r for r in caplog.records if r.exc_info and r.exc_info[1] is exc]
    assert logged, "the crash is logged on the host with its traceback"
    assert "guest_get_project" in logged[0].getMessage()


def test_guest_tool_refusal_returns_message_and_code(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.util.coded_error import CodedKeyError

    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"], label="refuse")
    _raising_tool(monkeypatch, CodedKeyError("comment not found: c9", code="comment_not_found"))

    text, structured = _tool_error(_call(share["token"], "guest_get_project", {}))
    assert text == "comment not found: c9"
    assert structured == {
        "ok": False,
        "error": "comment not found: c9",
        "error_code": "comment_not_found",
    }


def test_guest_tool_refusal_redacts_host_paths(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.util.coded_error import CodedFileNotFoundError

    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"], label="paths")
    _raising_tool(
        monkeypatch,
        CodedFileNotFoundError(f"raw media not found: {_HOST_SECRET}", code="file_not_found"),
    )

    out = _call(share["token"], "guest_get_project", {})
    text, structured = _tool_error(out)
    assert text == "raw media not found: [path]"
    assert structured is not None
    assert structured["error_code"] == "file_not_found"
    assert "/Users/host" not in json.dumps(out)


def test_guest_ab_preview_refusal_names_the_wav_not_the_host_path(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.services.document import PlayService
    from podcast_mcp.services.remote_mcp import tools as rt

    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"], label="ab")
    show = tmp_workspace / "My Secret Show"

    def preview():
        PlayService(rt.get_remote_mcp_context().workspace).play_ab_wavs(
            show / "A.wav", sample_wav, dry_run=True
        )

    monkeypatch.setattr(rt, "TOOL_HANDLERS", {**rt.TOOL_HANDLERS, "guest_get_project": preview})

    out = _call(share["token"], "guest_get_project", {})

    text, structured = _tool_error(out)
    assert text == "A wav not found: A.wav"
    assert structured is not None
    assert structured["error_code"] == "file_not_found"
    assert "Secret" not in json.dumps(out)


def test_protocol_maps_busy_lock_timeout_to_project_busy(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from filelock import Timeout

    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"], label="busy")
    _raising_tool(monkeypatch, Timeout("/some/secret/lock/path"))

    out = _call(share["token"], "guest_get_project", {})
    text, structured = _tool_error(out)
    assert structured is not None
    assert structured["error_code"] == "project_busy"
    assert structured["error"] == text
    assert "/secret" not in json.dumps(out)


def test_guest_unknown_comment_is_a_refusal_not_method_not_found(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(
        ws, monkeypatch, tmp_workspace, ["play", "view", "comment", "reply", "mcp"], label="nf"
    )
    out = _call(
        share["token"],
        "guest_add_reply",
        {"comment_id": "no-such-comment", "body": "hi", "author": "guest"},
    )
    text, structured = _tool_error(out)
    assert text == "comment not found: no-such-comment"
    assert structured is not None
    assert structured["error_code"] == "comment_not_found"


def test_guest_protocol_errors_are_reserved_for_the_protocol(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"], label="rpc")
    token = share["token"]

    unknown_method = handle_mcp_jsonrpc(
        token, {"jsonrpc": "2.0", "id": 1, "method": "tools/nope", "params": {}}
    )
    assert unknown_method["error"]["code"] == -32601

    # An unknown tool is an invalid tools/call parameter (MCP spec), not an unknown method.
    unknown_tool = _call(token, "pipeline_run", {})
    assert unknown_tool["error"]["code"] == -32602
    assert unknown_tool["error"]["message"] == "unknown tool: pipeline_run"

    missing = _call(token, "guest_search_transcript", {})
    assert missing["error"]["code"] == -32602
    assert missing["error"]["data"] == {"error_code": "invalid_arguments"}
    assert "query" in missing["error"]["message"]

    wrong_type = _call(token, "guest_search_transcript", {"query": "x", "limit": "many"})
    assert wrong_type["error"]["code"] == -32602
    assert "limit" in wrong_type["error"]["message"]

    extra = _call(token, "guest_get_project", {"project_path": "/etc"})
    assert extra["error"]["code"] == -32602
    assert "project_path" in extra["error"]["message"]

    denied = _call(token, "guest_add_comment", {"body": "x", "author": "a", "timeline_start": 0})
    assert denied["error"]["code"] == -32003


def test_guest_share_whose_project_is_gone_is_not_found_without_its_path(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"], label="gone")

    def _missing(_token):
        raise FileNotFoundError(f"Project not found: {_HOST_SECRET}")

    monkeypatch.setattr(
        "podcast_mcp.services.remote_mcp.protocol.resolve_remote_mcp_context", _missing
    )
    out = handle_mcp_jsonrpc(share["token"], {"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert out["error"] == {"code": -32004, "message": "share not found"}


def test_guest_share_resolution_crash_is_generic(
    minimal_project, sample_wav, tmp_workspace, monkeypatch, caplog
):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"], label="crash")

    def _crash(_token):
        raise RuntimeError(f"registry corrupt at {_HOST_SECRET}")

    monkeypatch.setattr(
        "podcast_mcp.services.remote_mcp.protocol.resolve_remote_mcp_context", _crash
    )
    with caplog.at_level("ERROR", logger="podcast_mcp.services.remote_mcp.protocol"):
        out = handle_mcp_jsonrpc(share["token"], {"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert out["error"] == {"code": -32603, "message": "internal error"}
    assert any(r.exc_info for r in caplog.records)


def test_guest_mcp_sse_failure_is_generic(monkeypatch, caplog):
    import asyncio

    from podcast_mcp.services.remote_mcp import progress as rp

    def _explode(*_args, **_kwargs):
        raise RuntimeError(f"pool died near {_HOST_SECRET}")

    monkeypatch.setattr("podcast_mcp.services.remote_mcp.protocol.handle_mcp_jsonrpc", _explode)

    async def _frames() -> list[str]:
        body = {"jsonrpc": "2.0", "id": 7, "method": "ping", "params": {}}
        return [frame async for frame in rp.iter_mcp_sse("tok", body)]

    with caplog.at_level("ERROR", logger="podcast_mcp.services.remote_mcp.progress"):
        frames = asyncio.run(_frames())
    last = json.loads(frames[-1].split("data: ", 1)[1])
    assert last["error"] == {"code": -32603, "message": "internal error"}
    assert last["id"] == 7
    assert "/Users/host" not in "".join(frames)
    assert any(r.exc_info for r in caplog.records)


def test_guest_render_job_lookups_and_upload_arguments_are_refusals(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(
        ws, monkeypatch, tmp_workspace, capabilities_for_role("editor", with_mcp=True), label="ed"
    )
    token = share["token"]

    text, structured = _tool_error(_call(token, "guest_render_preview_job", {"job_id": "nope"}))
    assert text == "Render preview job not found"
    assert structured is not None
    assert structured["error_code"] == "job_not_found"

    bad = _call(token, "guest_upload_media", {"filename": "a.wav", "data_base64": "%%%"})
    assert bad["error"]["code"] == -32602
    assert bad["error"]["message"] == "data_base64 must be valid base64"
    assert bad["error"]["data"] == {"error_code": "invalid_arguments"}


def test_guest_pending_preview_unknown_edit_is_a_refusal(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"], label="pp")
    text, structured = _tool_error(
        _call(share["token"], "guest_pending_preview", {"edit_id": "missing"})
    )
    assert text == "pending edit not found: missing"
    assert structured is not None
    assert structured["error_code"] == "edit_not_found"


def test_search_transcript_requires_view_cap(monkeypatch):
    from podcast_mcp.services.remote_mcp import tools as rt

    monkeypatch.setattr(rt, "_require_tool", lambda _n: None)
    monkeypatch.setattr(
        rt,
        "get_remote_mcp_context",
        lambda: type("C", (), {"capabilities": ["play"], "workspace": object()})(),
    )
    try:
        rt.guest_search_transcript("hi")
        raise AssertionError("expected PermissionError")
    except PermissionError as exc:
        assert "view" in str(exc)


def test_document_command_sanitizes_snapshot_project(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    from podcast_mcp.services.remote_mcp import tools as rt

    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(
        ws, monkeypatch, tmp_workspace, capabilities_for_role("editor", with_mcp=True), label="san"
    )

    class FakeSvc:
        def __init__(self, *_a, **_k):
            pass

        def submit(self, _cmd, **_kwargs):
            return {
                "ok": True,
                "snapshot": {
                    "project": {
                        "project_path": "/Users/secret/episode.project.json",
                        "meta": {"name": "x"},
                    }
                },
            }

    monkeypatch.setattr(rt, "DocumentSyncService", FakeSvc)
    out = _call(
        share["token"],
        "guest_submit_document_command",
        {"type": "ApproveEdits", "payload": {"ids": []}},
    )
    text = out["result"]["content"][0]["text"]
    assert "/Users/" not in text
    payload = json.loads(text)
    assert payload["snapshot"]["project"].get("project_path") in ("", None) or "/Users/" not in str(
        payload["snapshot"]["project"].get("project_path")
    )


def test_guest_render_preview_strips_host_paths(monkeypatch):
    from podcast_mcp.services.remote_mcp import tools as rt

    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    monkeypatch.setattr(rt, "_require_tool", lambda _n: None)

    class FakeWs:
        path = Path("/tmp/episode.project.json")

    monkeypatch.setattr(
        rt,
        "get_remote_mcp_context",
        lambda: type(
            "C", (), {"capabilities": capabilities_for_role("editor"), "workspace": FakeWs()}
        )(),
    )

    class FakeJob:
        id = "render-1"
        kind = "render_preview"
        project_path = "/tmp/episode.project.json"
        status = "ok"
        error = None

        def snapshot(self):
            return {"status": "ok", "current": 1, "total": 1}

    class FakeJobs:
        def start_render_preview(self, _path):
            return FakeJob()

        def get_job(self, _id):
            return FakeJob()

    monkeypatch.setattr(
        "podcast_mcp.gui.jobs.shared_job_manager",
        lambda: FakeJobs(),
    )
    out = rt.guest_render_preview()
    assert out["job"]["id"] == "render-1"
    assert "path" not in str(out)
    assert rt.guest_render_preview_job("render-1")["job"]["status"] == "ok"


def test_guest_render_preview_requires_opt_in(monkeypatch):
    from podcast_mcp.services.remote_mcp import tools as rt

    monkeypatch.delenv("PODCAST_GUEST_RENDER", raising=False)
    monkeypatch.setattr(rt, "_require_tool", lambda _n: None)
    monkeypatch.setattr(
        rt,
        "get_remote_mcp_context",
        lambda: type(
            "C", (), {"capabilities": capabilities_for_role("editor"), "workspace": object()}
        )(),
    )
    with pytest.raises(PermissionError, match="PODCAST_GUEST_RENDER"):
        rt.guest_render_preview()


def test_guest_render_preview_busy_is_runtime_error(monkeypatch):
    from podcast_mcp.services.remote_mcp import tools as rt

    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    monkeypatch.setattr(rt, "_require_tool", lambda _n: None)
    monkeypatch.setattr(
        rt,
        "get_remote_mcp_context",
        lambda: type(
            "C",
            (),
            {
                "capabilities": capabilities_for_role("editor"),
                "workspace": type("W", (), {"path": Path("/tmp/x")})(),
            },
        )(),
    )

    class BusyJobs:
        def start_render_preview(self, _path):
            raise RuntimeError("another pipeline job is already running")

    monkeypatch.setattr("podcast_mcp.gui.jobs.shared_job_manager", lambda: BusyJobs())
    with pytest.raises(RuntimeError, match="already running"):
        rt.guest_render_preview()


def test_guest_render_preview_non_dict_ok(monkeypatch):
    from podcast_mcp.services.remote_mcp import tools as rt

    monkeypatch.setenv("PODCAST_GUEST_RENDER", "1")
    monkeypatch.setattr(rt, "_require_tool", lambda _n: None)

    class FakeWs:
        path = Path("/tmp/episode.project.json")

    monkeypatch.setattr(
        rt,
        "get_remote_mcp_context",
        lambda: type(
            "C", (), {"capabilities": capabilities_for_role("editor"), "workspace": FakeWs()}
        )(),
    )

    class FakeJob:
        id = "render-1"
        kind = "render_preview"
        project_path = "/tmp/episode.project.json"
        status = "ok"
        error = None

        def snapshot(self):
            return {"status": "ok", "current": 1, "total": 1}

    class FakeJobs:
        def start_render_preview(self, _path):
            return FakeJob()

    monkeypatch.setattr(
        "podcast_mcp.gui.jobs.shared_job_manager",
        lambda: FakeJobs(),
    )
    assert rt.guest_render_preview() == {
        "job": {
            "id": "render-1",
            "status": "ok",
            "current": 1,
            "total": 1,
            "message": None,
            "error": None,
        }
    }


def test_guest_get_session_presence_requires_view(minimal_project, monkeypatch):
    from podcast_mcp.services.remote_mcp import tools as rt
    from podcast_mcp.services.remote_mcp.context import (
        RemoteMcpContext,
        clear_remote_mcp_context,
        set_remote_mcp_context,
    )

    monkeypatch.setattr(rt, "_require_tool", lambda _n: None)
    ctx = RemoteMcpContext(
        token="t",
        capabilities=["play", "mcp"],
        workspace=ProjectWorkspace.open(minimal_project),
        author="share:t",
    )
    set_remote_mcp_context(ctx)
    try:
        with pytest.raises(PermissionError, match="share does not allow view"):
            rt.guest_get_session_presence()
    finally:
        clear_remote_mcp_context()


def test_guest_submit_without_client_seq_applies_each_command(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(
        ws, monkeypatch, tmp_workspace, capabilities_for_role("editor", with_mcp=True), label="seq"
    )
    for _ in range(2):
        out = _call(
            share["token"],
            "guest_submit_document_command",
            {"type": "ApproveEdits", "payload": {"ids": []}},
        )
        assert "error" not in out, out
        assert not json.loads(out["result"]["content"][0]["text"]).get("idempotent")
    from podcast_mcp.services.document_sync import DocumentSyncService

    rows = DocumentSyncService.open(minimal_project).store.commands_after(0)
    assert [r["client_seq"] for r in rows] == [-1, -2]
