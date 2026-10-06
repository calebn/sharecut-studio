"""Guest document-command gate: each share capability set against each command.

Owner rules (#6, #1004, #1005): ``edit`` guests edit on every surface, ``suggest``
guests only suggest, and view/play/comment guests do neither. Every document
command needs ``view`` on both the browser and the guest MCP surface.
"""

from __future__ import annotations

import itertools
import json
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.edits.transcript_cuts import append_remove_decision
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.services.document_sync.capabilities import authorize_document_command
from podcast_mcp.services.remote_mcp.allowlist import tools_for_capabilities
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from test_selected_range import command, fixture, target

LISTEN = ["play", "comment", "reply", "action"]
VIEW = [*LISTEN, "view"]
SUGGEST = [*VIEW, "suggest"]
EDIT = [*VIEW, "edit"]


def guest_command(command_type: str, payload: dict) -> DocumentCommand:
    return DocumentCommand(
        type=command_type, payload=payload, client_id="guest", client_seq=None, role="guest"
    )


def pending_project(minimal_project) -> DocumentSyncService:
    """Pending edits from the host (no reason), an agent (``nl:range``) and a guest
    suggestion saved without an author (as before #1010)."""
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
        (SUGGEST, set()),
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


@pytest.mark.parametrize("surface", ["browser", "mcp"])
def test_suggest_guests_retime_only_their_own_suggestions(
    minimal_project, sample_wav, monkeypatch, surface
):
    pending_project(minimal_project)
    shares = {
        who: _mcp_share(minimal_project, sample_wav, monkeypatch, [*caps, "mcp"])
        for who, caps in (("ann", SUGGEST), ("bob", SUGGEST), ("editor", EDIT))
    }
    client = TestClient(create_app())
    seq = itertools.count(1)

    def submit(who: str, command_type: str, payload: dict) -> bool:
        body = {
            "type": command_type,
            "payload": payload,
            "client_id": f"{surface}-{who}",
            "client_seq": next(seq),
        }
        if surface == "mcp":
            return "error" not in _mcp_call(shares[who], "guest_submit_document_command", body)
        response = client.post(
            f"/api/review/{shares[who]}/daw/document/command", json={**body, "role": "guest"}
        )
        assert response.status_code in (200, 403), response.text
        return response.status_code == 200

    for who, start in (("ann", 5.0), ("bob", 6.0)):
        assert submit(
            who, "SuggestPendingEdit", {"track_id": "c", "start": start, "end": start + 0.5}
        )
    by_start = {e.start: e.id for e in load_project(minimal_project).edit_decisions}
    suggestion = {"ann": by_start[5.0], "bob": by_start[6.0]}

    def retime(who: str, whose: str, start: float) -> bool:
        payload = {"id": suggestion[whose], "start": start, "end": start + 0.5, "snap": False}
        return submit(who, "UpdatePendingEdit", payload)

    outcome = {
        (who, whose): retime(who, whose, start)
        for (who, whose), start in zip(
            itertools.product(("ann", "bob", "editor"), ("ann", "bob")),
            (7.0, 8.0, 9.0, 10.0, 11.0, 12.0),
            strict=True,
        )
    }
    assert outcome == {
        ("ann", "ann"): True,
        ("ann", "bob"): False,
        ("bob", "ann"): False,
        ("bob", "bob"): True,
        ("editor", "ann"): True,
        ("editor", "bob"): True,
    }
    host = DocumentSyncService.open(minimal_project)
    for whose, start in (("ann", 13.0), ("bob", 14.0)):
        host.submit(
            DocumentCommand(
                type="UpdatePendingEdit",
                payload={
                    "id": suggestion[whose],
                    "start": start,
                    "end": start + 0.5,
                    "snap": False,
                },
                client_id="host",
                client_seq=None,
                role="viewer",
            ),
            range_policy="apply",
        )
    starts = {e.id: e.start for e in load_project(minimal_project).edit_decisions}
    assert (starts[suggestion["ann"]], starts[suggestion["bob"]]) == (13.0, 14.0)

    state = client.get(f"/api/review/{shares['ann']}/daw/document/state?phase=full").json()
    rows = state["project"]["pending_edits"]
    assert {row["id"] for row in rows} >= set(suggestion.values())
    assert all("author" not in row for row in rows)
    assert "share:" not in json.dumps(state)


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


@pytest.mark.parametrize(
    ("caps", "offered"),
    [(["play", "edit", "mcp"], set()), (["play", "view", "edit", "mcp"], {"render", "upload"})],
    ids=["edit-without-view", "edit-with-view"],
)
def test_guest_mcp_offers_edit_tools_only_when_the_gate_allows_edit(
    minimal_project, sample_wav, monkeypatch, caps, offered
):
    token = _mcp_share(minimal_project, sample_wav, monkeypatch, caps)
    listed = handle_mcp_jsonrpc(
        token, {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    )
    names = {tool["name"] for tool in listed["result"]["tools"]}
    edit_tools = {
        "guest_render_preview": "render",
        "guest_render_preview_job": "render",
        "guest_upload_media": "upload",
    }
    assert {kind for name, kind in edit_tools.items() if name in names} == offered
    upload = _mcp_call(token, "guest_upload_media", {"filename": "x.wav", "data_base64": ""})
    refused = upload.get("error", {}).get("code") == -32003
    assert refused is not bool(offered), upload


def range_project(minimal_project) -> DocumentSyncService:
    ws = ProjectWorkspace.open(minimal_project)
    fixture(ws.project)
    save_project(ws.project)
    return DocumentSyncService.open(minimal_project)


@pytest.mark.parametrize("action", ["cut", "mute"])
@pytest.mark.parametrize(
    ("caps", "range_policy", "outcome"),
    [
        (VIEW, "apply", None),
        (VIEW, "propose", None),
        (SUGGEST, "apply", "guest:suggest"),
        (SUGGEST, "propose", "guest:suggest"),
        (EDIT, "apply", "applied"),
        (EDIT, "propose", "applied"),
        ([*SUGGEST, "edit"], "propose", "applied"),
        (None, "apply", "applied"),
        (None, "propose", "agent:range"),
    ],
    ids=[
        "view-daw",
        "view-mcp",
        "suggest-daw",
        "suggest-mcp",
        "edit-daw",
        "edit-mcp",
        "editor-mcp",
        "host-daw",
        "host-agent",
    ],
)
def test_selected_range_mode_follows_capabilities_on_every_surface(
    minimal_project, caps, range_policy, outcome, action
):
    svc = range_project(minimal_project)
    before = deepcopy(svc.ws.project.clips)
    cmd = command(target(svc.ws.project), action)
    if outcome is None:
        with pytest.raises(PermissionError, match="EditSelectedRange"):
            svc.submit(cmd, capabilities=caps, range_policy=range_policy)
        assert load_project(minimal_project).clips == before
        return
    svc.submit(cmd, capabilities=caps, range_policy=range_policy)
    project = load_project(minimal_project)
    if outcome == "applied":
        assert project.edit_decisions == []
        assert project.editorial.edit_log[-1].params["action"] == action
        assert project.clips != before
    else:
        assert [d.reason for d in project.edit_decisions] == [outcome]
        assert project.clips == before


def suggest_both_kinds(svc: DocumentSyncService) -> dict[str, str]:
    """One exact selected-range and one source suggestion, both from a suggest guest."""
    exact = command(target(svc.ws.project))
    svc.submit(exact, capabilities=SUGGEST, range_policy="apply")
    svc.submit(
        guest_command("SuggestPendingEdit", {"track_id": "c", "start": 15.0, "end": 15.5}),
        capabilities=SUGGEST,
        range_policy="apply",
    )
    source = next(e.id for e in svc.ws.project.edit_decisions if e.exact_range is None)
    return {"exact": exact.command_id, "source": source}


@pytest.mark.parametrize("kind", ["exact", "source"])
@pytest.mark.parametrize("decide", ["ApproveEdits", "RejectEdits"])
@pytest.mark.parametrize("range_policy", ["apply", "propose"], ids=["daw", "mcp"])
@pytest.mark.parametrize(
    ("caps", "allowed"),
    [(VIEW, False), (SUGGEST, False), (EDIT, True)],
    ids=["view", "suggest", "edit"],
)
def test_only_edit_guests_decide_pending_suggestions(
    minimal_project, caps, allowed, range_policy, decide, kind
):
    svc = range_project(minimal_project)
    edit_id = suggest_both_kinds(svc)[kind]
    before = deepcopy(load_project(minimal_project))
    decision = guest_command(decide, {"ids": [edit_id]})
    if not allowed:
        with pytest.raises(PermissionError):
            svc.submit(decision, capabilities=caps, range_policy=range_policy)
        assert load_project(minimal_project).edit_decisions == before.edit_decisions
        return
    svc.submit(decision, capabilities=caps, range_policy=range_policy)
    project = load_project(minimal_project)
    assert edit_id not in {e.id for e in project.edit_decisions}
    assert len(project.edit_decisions) == 1
    if decide == "RejectEdits":
        assert project.clips == before.clips
    else:
        assert project.clips != before.clips


def host_undo(minimal_project) -> None:
    DocumentSyncService.open(minimal_project).submit(
        DocumentCommand(
            type="UndoHistory", payload={}, client_id="host", client_seq=None, role="viewer"
        ),
        range_policy="apply",
    )


def saved_state(minimal_project):
    project = load_project(minimal_project)
    return (
        [e.model_dump() for e in project.edit_decisions],
        [c.model_dump() for c in project.clips],
        [r.model_dump() for r in project.editorial.edit_log],
    )


@pytest.mark.parametrize("change", ["approve", "reject", "cut", "mute", "retime"])
def test_host_undoes_each_edit_guest_mcp_change(minimal_project, change):
    svc = range_project(minimal_project)
    ids = suggest_both_kinds(svc)
    host = append_remove_decision(svc.ws.project, "c", 1.0, 1.5, reason="")
    host.reason = None
    save_project(svc.ws.project)
    svc = DocumentSyncService.open(minimal_project)
    before = saved_state(minimal_project)
    lane = target(svc.ws.project, intervals=((2, 3),), tracks=("c",))
    commands = {
        "approve": guest_command("ApproveEdits", {"ids": [ids["exact"]]}),
        "reject": guest_command("RejectEdits", {"ids": [ids["exact"]]}),
        "cut": command(lane, "cut"),
        "mute": command(lane, "mute"),
        "retime": guest_command(
            "UpdatePendingEdit", {"id": host.id, "start": 4.0, "end": 4.25, "snap": False}
        ),
    }
    svc.submit(commands[change], capabilities=EDIT, range_policy="propose")
    assert saved_state(minimal_project) != before
    host_undo(minimal_project)
    assert saved_state(minimal_project) == before


@pytest.mark.parametrize(
    ("caps", "outcome"),
    [
        (["play", "view", "suggest", "mcp"], "proposed"),
        (["play", "view", "edit", "mcp"], "applied"),
    ],
    ids=["suggest", "edit"],
)
def test_guest_mcp_range_cut_follows_the_share(
    minimal_project, sample_wav, monkeypatch, caps, outcome
):
    svc = range_project(minimal_project)
    before = deepcopy(svc.ws.project.clips)
    cut = command(target(svc.ws.project))
    token = _mcp_share(minimal_project, sample_wav, monkeypatch, caps)
    out = _mcp_call(
        token,
        "guest_submit_document_command",
        {"type": cut.type, "payload": cut.payload, "command_id": cut.command_id},
    )
    assert "error" not in out, out
    project = load_project(minimal_project)
    if outcome == "applied":
        assert project.edit_decisions == []
        assert project.clips != before
    else:
        assert [d.reason for d in project.edit_decisions] == ["guest:suggest"]
        assert project.clips == before
