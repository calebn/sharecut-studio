"""Capability-scoped remote MCP allowlist + JSON-RPC bridge tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools import guest as guest_tools_pkg
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.document_sync.capabilities import (
    document_command_types_for_caps,
)
from podcast_mcp.services.remote_mcp.allowlist import (
    tool_allowed,
    tools_for_capabilities,
)
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.services.share import ShareService


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

    suggest = tools_for_capabilities(["play", "view", "suggest", "mcp"])
    assert "guest_submit_document_command" in suggest
    assert tool_allowed(["play", "view", "suggest", "mcp"], "guest_submit_document_command")

    edit = tools_for_capabilities(["play", "view", "edit", "mcp"])
    assert "guest_submit_document_command" in edit
    assert "guest_render_preview" in edit
    assert "guest_upload_media" in edit
    assert "guest_render_preview" not in suggest
    assert "guest_upload_media" not in view

    assert tools_for_capabilities([]) == frozenset()
    assert tools_for_capabilities(["mcp"]) == frozenset()
    assert "ApproveEdits" in document_command_types_for_caps(["edit"])
    assert "SuggestPendingEdit" in document_command_types_for_caps(["suggest"])
    assert "SplitAtTime" in document_command_types_for_caps(["edit"])
    assert "SplitAtTime" in document_command_types_for_caps(["suggest"])
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
    assert unknown_tool["error"]["code"] == -32601

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
    assert "error" in action

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
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "suggest", "mcp"], label="sug")
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


def test_protocol_surfaces_tool_exceptions(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from podcast_mcp.services.remote_mcp import tools as rt

    ws = _seed_premix(minimal_project, sample_wav)
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "mcp"], label="boom")

    def _boom():
        raise ValueError("boom")

    monkeypatch.setattr(rt, "TOOL_HANDLERS", {**rt.TOOL_HANDLERS, "guest_get_project": _boom})
    err = _call(share["token"], "guest_get_project", {})
    assert err["error"]["code"] == -32000
    assert "boom" in err["error"]["message"]


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
    share = _share(ws, monkeypatch, tmp_workspace, ["play", "view", "edit", "mcp"], label="san")

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
        lambda: type("C", (), {"capabilities": ["edit"], "workspace": FakeWs()})(),
    )

    class FakeJob:
        status = "ok"
        error = None

    class FakeJobs:
        def start_render_preview(self, _path):
            return FakeJob()

    monkeypatch.setattr(
        "podcast_mcp.gui.jobs.shared_job_manager",
        lambda: FakeJobs(),
    )
    out = rt.guest_render_preview(rerender=True)
    assert out["ok"] is True
    assert "path" not in out
    assert "premix_path" not in out


def test_guest_render_preview_requires_opt_in(monkeypatch):
    from podcast_mcp.services.remote_mcp import tools as rt

    monkeypatch.delenv("PODCAST_GUEST_RENDER", raising=False)
    monkeypatch.setattr(rt, "_require_tool", lambda _n: None)
    monkeypatch.setattr(
        rt,
        "get_remote_mcp_context",
        lambda: type("C", (), {"capabilities": ["edit"], "workspace": object()})(),
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
            {"capabilities": ["edit"], "workspace": type("W", (), {"path": Path("/tmp/x")})()},
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
        lambda: type("C", (), {"capabilities": ["edit"], "workspace": FakeWs()})(),
    )

    class FakeJob:
        status = "ok"
        error = None

    class FakeJobs:
        def start_render_preview(self, _path):
            return FakeJob()

    monkeypatch.setattr(
        "podcast_mcp.gui.jobs.shared_job_manager",
        lambda: FakeJobs(),
    )
    assert rt.guest_render_preview() == {"ok": True}


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
    )
    set_remote_mcp_context(ctx)
    try:
        with pytest.raises(PermissionError, match="share does not allow view"):
            rt.guest_get_session_presence()
    finally:
        clear_remote_mcp_context()
