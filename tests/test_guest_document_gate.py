"""Guest document-command gate: each share capability set against each command.

Owner rules (#6, #1004, #1005): ``edit`` guests edit on every surface, ``suggest``
guests only suggest, and view/play/comment guests do neither. Every document
command needs ``view`` on both the browser and the guest MCP surface.
"""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest

from podcast_mcp.edits.transcript_cuts import append_remove_decision
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.services.document_sync.capabilities import authorize_document_command
from podcast_mcp.services.remote_mcp.allowlist import tools_for_capabilities
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from test_selected_range import fixture

LISTEN = ["play", "comment", "reply", "action"]
VIEW = [*LISTEN, "view"]
SUGGEST = [*VIEW, "suggest"]
EDIT = [*VIEW, "edit"]


def guest_command(command_type: str, payload: dict) -> DocumentCommand:
    return DocumentCommand(
        type=command_type, payload=payload, client_id="guest", client_seq=None, role="guest"
    )


def pending_project(minimal_project) -> DocumentSyncService:
    """Pending edits from the host (no reason), an agent (``nl:range``) and a guest."""
    ws = ProjectWorkspace.open(minimal_project)
    project = fixture(ws.project)
    for edit_id, reason, start in (("host", None, 1.0), ("agent", "nl:range", 2.0)):
        decision = append_remove_decision(project, "c", start, start + 0.5, reason=reason or "")
        decision.id = edit_id
        decision.reason = reason
    guest = append_remove_decision(project, "c", 3.0, 3.5, reason="guest:suggest")
    guest.id = "guest"
    save_project(project)
    return DocumentSyncService.open(minimal_project)


def retime(svc: DocumentSyncService, caps: list[str], edit_id: str) -> None:
    svc.submit(
        guest_command(
            "UpdatePendingEdit", {"id": edit_id, "start": 4.0, "end": 4.25, "snap": False}
        ),
        capabilities=caps,
        range_policy="apply",
    )


@pytest.mark.parametrize("edit_id", ["host", "agent", "guest"])
@pytest.mark.parametrize(
    ("caps", "allowed"),
    [
        (VIEW, set()),
        (SUGGEST, {"guest"}),
        (EDIT, {"host", "agent", "guest"}),
    ],
    ids=["view", "suggest", "edit"],
)
def test_retiming_a_pending_edit_follows_its_author(minimal_project, caps, allowed, edit_id):
    svc = pending_project(minimal_project)
    before = deepcopy(svc.ws.project.edit_decisions)
    if edit_id in allowed:
        retime(svc, caps, edit_id)
        edit = next(e for e in load_project(minimal_project).edit_decisions if e.id == edit_id)
        assert (edit.start, edit.end) == (4.0, 4.25)
        return
    with pytest.raises(PermissionError):
        retime(svc, caps, edit_id)
    assert load_project(minimal_project).edit_decisions == before


@pytest.mark.parametrize(
    ("caps", "command_type"),
    [
        (["suggest"], "SuggestPendingEdit"),
        (["play", "suggest", "mcp"], "UpdatePendingEdit"),
        (["edit"], "ApproveEdits"),
        (["play", "comment", "edit", "mcp"], "EditSelectedRange"),
    ],
)
def test_document_commands_need_view(caps, command_type):
    with pytest.raises(PermissionError, match=command_type):
        authorize_document_command(caps, command_type)
    authorize_document_command([*caps, "view"], command_type)


def _mcp_share(minimal_project, sample_wav, monkeypatch, caps: list[str]) -> str:
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    ws = ProjectWorkspace.open(minimal_project)
    artifacts = Path(ws.project.workspace_dir) / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / "premix.wav").write_bytes(sample_wav.read_bytes())
    version = ReviewService(ws).publish(label="gate")
    return ShareService(ws).create(review_version_id=version["id"], capabilities=caps)["token"]


def _mcp_call(token: str, name: str, arguments: dict) -> dict:
    return handle_mcp_jsonrpc(
        token,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    )


@pytest.mark.parametrize("cap", ["suggest", "edit"])
def test_guest_mcp_needs_view_like_the_browser(minimal_project, sample_wav, monkeypatch, cap):
    pending_project(minimal_project)
    suggest = {
        "type": "SuggestPendingEdit",
        "payload": {"track_id": "c", "start": 5.0, "end": 5.5},
    }
    blind = _mcp_share(minimal_project, sample_wav, monkeypatch, ["play", cap, "mcp"])
    assert "guest_submit_document_command" not in tools_for_capabilities(["play", cap, "mcp"])
    denied = _mcp_call(blind, "guest_submit_document_command", suggest)
    assert "error" in denied
    assert len(load_project(minimal_project).edit_decisions) == 3

    seeing = _mcp_share(
        minimal_project, sample_wav, monkeypatch, ["play", "view", "suggest", "mcp"]
    )
    allowed = _mcp_call(seeing, "guest_submit_document_command", suggest)
    assert "error" not in allowed, allowed
    assert json.loads(allowed["result"]["content"][0]["text"])["ok"] is True
    assert len(load_project(minimal_project).edit_decisions) == 4
