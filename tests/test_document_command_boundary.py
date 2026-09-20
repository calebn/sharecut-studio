"""Boundary validation for typed document commands across HTTP / WS / MCP.

Keeps the published contract honest: invalid payloads must fail at each adapter
before DocumentSyncService.submit (422 / WS Error / ValidationError / -32602).
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools.agent_document import submit_host_document_command
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.document_sync.payloads import document_command_json_schema
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.services.remote_mcp.tools import tool_input_schema
from podcast_mcp.services.share import ShareService

# Wrong field name for ApproveEdits (real key is ``ids``).
_BAD_APPROVE = {
    "type": "ApproveEdits",
    "payload": {"decision_ids": ["x"]},
    "client_id": "boundary-test",
    "client_seq": 1,
}


def _seed_premix(minimal_project, sample_wav) -> ProjectWorkspace:
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _edit_share(ws: ProjectWorkspace, monkeypatch, tmp_workspace) -> dict:
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    ver = ReviewService(ws).publish(label="boundary")
    return ShareService(ws).create(
        review_version_id=ver["id"],
        public_base_url="https://share.example",
        capabilities=["play", "view", "edit", "comment", "action", "mcp"],
    )


def test_openapi_document_command_matches_published_schema():
    """Live OpenAPI oneOf set matches the checked-in / MCP-exported schema."""
    published = document_command_json_schema()
    mcp = tool_input_schema("guest_submit_document_command")
    assert mcp == published

    client = TestClient(create_app())
    openapi = client.get("/openapi.json").json()
    body = openapi["paths"]["/api/document/command"]["post"]["requestBody"]["content"][
        "application/json"
    ]["schema"]
    assert body.get("discriminator", {}).get("propertyName") == "type"
    oa_refs = [item["$ref"].rsplit("/", 1)[-1] for item in body["oneOf"]]
    pub_defs = published.get("$defs") or {}
    # Pydantic export names commands in $defs; OpenAPI promotes them to components.
    pub_cmds = sorted(k for k in pub_defs if k.endswith("Command"))
    assert sorted(oa_refs) == pub_cmds
    assert len(oa_refs) == len(pub_cmds) >= 30


def test_host_http_rejects_invalid_document_payload(minimal_project):
    client = TestClient(create_app())
    r = client.post(
        f"/api/document/command?path={quote(str(minimal_project))}",
        json=_BAD_APPROVE,
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert isinstance(detail, list)
    assert any("ids" in str(item) or "decision_ids" in str(item) for item in detail)


def test_guest_http_rejects_invalid_document_payload(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _edit_share(ws, monkeypatch, tmp_workspace)
    client = TestClient(create_app())
    r = client.post(
        f"/api/review/{share['token']}/daw/document/command",
        json=_BAD_APPROVE,
    )
    assert r.status_code == 422


def test_document_ws_rejects_invalid_payload(minimal_project):
    client = TestClient(create_app())
    url = f"/api/document/ws?path={quote(str(minimal_project))}&client_id=boundary-ws&role=viewer"
    with client.websocket_connect(url) as ws:
        snap = ws.receive_json()
        assert snap["type"] == "Snapshot"
        ws.send_json(
            {
                "type": "Command",
                "command_type": "ApproveEdits",
                "payload": {"decision_ids": ["x"]},
                "client_seq": 1,
            }
        )
        err = ws.receive_json()
        assert err["type"] == "Error"
        assert "decision_ids" in err["detail"] or "ids" in err["detail"]


def test_host_mcp_rejects_invalid_payload(minimal_project):
    with pytest.raises(ValidationError):
        submit_host_document_command(
            str(minimal_project),
            "ApproveEdits",
            {"decision_ids": ["x"]},
        )


def test_guest_mcp_rejects_invalid_document_payload(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _edit_share(ws, monkeypatch, tmp_workspace)
    out = handle_mcp_jsonrpc(
        share["token"],
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "guest_submit_document_command",
                "arguments": {
                    "type": "ApproveEdits",
                    "payload": {"decision_ids": ["x"]},
                    "client_id": "boundary-mcp",
                    "client_seq": 1,
                },
            },
        },
    )
    assert "error" in out
    assert out["error"]["code"] == -32602


def test_guest_comment_http_rejects_overlong_body(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
):
    ws = _seed_premix(minimal_project, sample_wav)
    share = _edit_share(ws, monkeypatch, tmp_workspace)
    client = TestClient(create_app())
    r = client.post(
        f"/api/review/{share['token']}/comments",
        json={
            "body": "x" * 8001,
            "author": "guest",
            "timeline_start": 0.0,
        },
    )
    assert r.status_code == 422
