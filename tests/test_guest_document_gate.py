"""Guest document-command gate: each review-link role against each command.

Owner rules (#6, #1004, #1005, #1050): roles follow Google Docs. Editors edit on
every surface, Commenters only suggest, and Viewers do neither. A share that holds
no role in full (the dropped suggest-only level, a link without ``view``) runs no
document command, on the browser and the guest MCP surface alike.
"""

from __future__ import annotations

import hashlib
import itertools
import json
from collections.abc import Callable
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import get_args

import pytest
from fastapi.testclient import TestClient

from history_helpers import history_move
from pause_policy_public_helpers import room, write_wav
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.transcript_cuts import append_remove_decision
from podcast_mcp.engines.effect_filters import format_effect, validate_effect_params
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import EditDecision, MediaAsset, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.review import ReviewService
from podcast_mcp.services.collaboration.share import ShareService
from podcast_mcp.services.collaboration.share_capabilities import (
    capabilities_for_role,
    share_author,
)
from podcast_mcp.services.collaboration.share_registry import (
    SHARE_COOLDOWN_DAYS,
    get_share_registry,
)
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.services.document_sync.capabilities import (
    COMMENT_COMMANDS,
    EDIT_COMMANDS,
    HOST_ONLY_DOCUMENT_COMMANDS,
    SUGGEST_COMMANDS,
    authorize_document_command,
    authorize_document_payload,
    document_command_types_for_caps,
)
from podcast_mcp.services.document_sync.commands import DocumentCommandType
from podcast_mcp.services.remote_mcp.allowlist import tools_for_capabilities
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.util.coded_error import CodedValueError
from test_selected_range import command, fixture, target

LISTEN = ["play", "comment", "reply", "action"]
SUGGEST_ONLY = ["play", "view", "suggest"]
VIEWER = capabilities_for_role("viewer")
COMMENTER = capabilities_for_role("commenter")
EDITOR = capabilities_for_role("editor")
COMMENTER_COMMANDS = {
    "SuggestPendingEdit",
    "UpdatePendingEdit",
    "EditSelectedRange",
    "SplitAtTime",
    "DeleteClip",
}


def allowed_commands(caps: list[str]) -> set[str]:
    allowed = set()
    for command_type in EDIT_COMMANDS | SUGGEST_COMMANDS:
        try:
            authorize_document_command(caps, command_type)
        except PermissionError:
            continue
        allowed.add(command_type)
    return allowed


@pytest.mark.parametrize(
    ("caps", "expected"),
    [
        (VIEWER, set()),
        (COMMENTER, COMMENTER_COMMANDS),
        (EDITOR, EDIT_COMMANDS | COMMENTER_COMMANDS),
        ([*EDITOR, "mcp"], EDIT_COMMANDS | COMMENTER_COMMANDS),
        (SUGGEST_ONLY, set()),
        (LISTEN, set()),
    ],
    ids=["viewer", "commenter", "editor", "editor-mcp", "suggest-only", "listen"],
)
def test_each_role_runs_exactly_its_document_commands(caps, expected):
    assert allowed_commands(caps) == expected


def test_an_editor_edits_volume_envelopes_and_other_roles_cannot(envelope_project):
    """Owner decision D-touch-input-grammar (#1051): Editor links change volume
    envelopes as the host does; Commenter and Viewer links cannot."""
    svc = DocumentSyncService.open(envelope_project)
    point = {"id": "guest-point", "time": 1.5, "value": 0.5}

    def set_envelope() -> DocumentCommand:
        baseline = load_project(envelope_project).automation_envelopes
        expected = [
            {"id": p.id, "time": p.time, "value": p.value}
            for envelope in baseline
            if envelope.track_id == "host" and envelope.parameter == "volume"
            for p in envelope.points
        ]
        return guest_command(
            "SetEnvelope",
            {"track_id": "host", "points": [point], "expected_points": expected},
        )

    for caps in (VIEWER, COMMENTER):
        with pytest.raises(PermissionError, match="SetEnvelope"):
            svc.submit(set_envelope(), capabilities=caps)
    svc.submit(set_envelope(), capabilities=EDITOR)

    volume = [
        envelope
        for envelope in load_project(envelope_project).automation_envelopes
        if envelope.track_id == "host" and envelope.parameter == "volume"
    ]
    assert [(p.id, p.time, p.value) for p in volume[0].points] == [("guest-point", 1.5, 0.5)]


def test_a_commenter_suggests_a_cut_and_an_editor_applies_it(minimal_project):
    svc = range_project(minimal_project)
    before = deepcopy(svc.ws.project.clips)
    cut = command(target(svc.ws.project))
    svc.submit(cut, capabilities=COMMENTER, range_policy="apply")
    project = load_project(minimal_project)
    assert [d.reason for d in project.edit_decisions] == ["guest:suggest"]
    assert project.clips == before
    approve = guest_command("ApproveEdits", {"ids": [cut.command_id]})
    for caps in (VIEWER, COMMENTER):
        with pytest.raises(PermissionError, match="ApproveEdits"):
            svc.submit(approve, capabilities=caps, range_policy="apply")
    assert load_project(minimal_project).clips == before
    with pytest.raises(PermissionError, match="EditSelectedRange"):
        svc.submit(command(target(svc.ws.project)), capabilities=VIEWER, range_policy="apply")

    svc.submit(approve, capabilities=EDITOR, range_policy="apply")
    project = load_project(minimal_project)
    assert project.edit_decisions == []
    assert project.clips != before


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
        decision = append_remove_decision(
            project, "c", start, start + 0.5, reason=reason or "", defaults=load_defaults()
        )
        decision.id = edit_id
        decision.reason = reason
    guest = append_remove_decision(
        project, "c", 3.0, 3.5, reason="guest:suggest", defaults=load_defaults()
    )
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
        (VIEWER, set()),
        (COMMENTER, set()),
        (EDITOR, {"host", "agent", "guest"}),
    ],
    ids=["viewer", "commenter", "editor"],
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


def guest_submitter(surface: str) -> Callable[[str, str, dict], bool]:
    """Submit a guest document command on *surface*; True when the gate allows it."""
    client = TestClient(create_app())
    seq = itertools.count(1)
    client_ids: dict[str, str] = {}

    def submit(token: str, command_type: str, payload: dict) -> bool:
        body = {
            "type": command_type,
            "payload": payload,
            "client_id": client_ids.setdefault(token, f"{surface}-{len(client_ids)}"),
            "client_seq": next(seq),
        }
        if surface == "mcp":
            return "error" not in _mcp_call(token, "guest_submit_document_command", body)
        response = client.post(
            f"/api/review/{token}/daw/document/command", json={**body, "role": "guest"}
        )
        assert response.status_code in (200, 403), response.text
        return response.status_code == 200

    return submit


def registry_author(token: str) -> str:
    return f"share:{get_share_registry().get_active(token)['id']}"


def edit_at(minimal_project, start: float) -> EditDecision:
    return next(e for e in load_project(minimal_project).edit_decisions if e.start == start)


@pytest.mark.parametrize("surface", ["browser", "mcp"])
def test_commenters_retime_only_their_own_suggestions(
    minimal_project, sample_wav, monkeypatch, surface
):
    pending_project(minimal_project)
    shares = {
        who: _mcp_share(minimal_project, sample_wav, monkeypatch, [*caps, "mcp"])
        for who, caps in (("ann", COMMENTER), ("bob", COMMENTER), ("editor", EDITOR))
    }
    submit_as = guest_submitter(surface)

    def submit(who: str, command_type: str, payload: dict) -> bool:
        return submit_as(shares[who], command_type, payload)

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

    client = TestClient(create_app())
    state = client.get(f"/api/review/{shares['ann']}/daw/document/state?phase=full").json()
    rows = state["project"]["pending_edits"]
    assert {row["id"] for row in rows} >= set(suggestion.values())
    authors = {row["id"]: row["author"] for row in rows}
    own = {
        who: client.get(f"/api/review/{shares[who]}/project").json()["author"]
        for who in ("ann", "bob")
    }
    assert own["ann"] != own["bob"]
    assert {who: authors[suggestion[who]] for who in ("ann", "bob")} == own
    assert not any(token in json.dumps(state) for token in shares.values())


@pytest.mark.parametrize("surface", ["browser", "mcp"])
def test_guest_edit_author_is_the_share_registry_id_not_the_token(
    minimal_project, sample_wav, monkeypatch, surface
):
    pending_project(minimal_project)
    ann, bob = (
        _mcp_share(minimal_project, sample_wav, monkeypatch, [*COMMENTER, "mcp"]) for _ in "ab"
    )
    submit = guest_submitter(surface)

    forged = {"track_id": "c", "start": 5.0, "end": 5.5, "author": registry_author(ann)}
    assert submit(bob, "SuggestPendingEdit", forged)
    suggestion = edit_at(minimal_project, 5.0)
    assert suggestion.author == registry_author(bob)
    retime = {"id": suggestion.id, "start": 6.0, "end": 6.5, "snap": False}
    assert not submit(ann, "UpdatePendingEdit", retime)
    assert submit(bob, "UpdatePendingEdit", retime)

    saved = Path(minimal_project).read_text(encoding="utf-8")
    assert registry_author(bob) in saved
    for token in (ann, bob):
        assert token not in saved
        assert hashlib.sha256(token.encode()).hexdigest()[:16] not in saved


def test_a_share_without_a_registry_id_cannot_author_edits():
    assert share_author({"token": "a-b-c", "id": "0f3a9c21d4e7"}) == "share:0f3a9c21d4e7"
    with pytest.raises(KeyError):
        share_author({"token": "a-b-c", "id": None})


def test_a_recycled_share_slug_does_not_inherit_the_old_author(
    minimal_project, sample_wav, monkeypatch
):
    pending_project(minimal_project)
    monkeypatch.setattr(
        "podcast_mcp.services.collaboration.share_registry.generate_slug",
        lambda _words=3: "recycled-cool-slug",
    )
    submit = guest_submitter("browser")
    first = _mcp_share(minimal_project, sample_wav, monkeypatch, COMMENTER)
    assert submit(first, "SuggestPendingEdit", {"track_id": "c", "start": 5.0, "end": 5.5})
    old = edit_at(minimal_project, 5.0)

    ShareService(ProjectWorkspace.open(minimal_project)).revoke(first)
    after_cooldown = datetime.now(UTC) + timedelta(days=SHARE_COOLDOWN_DAYS + 1)
    get_share_registry().purge_expired_cooldown(now=after_cooldown)
    second = _mcp_share(minimal_project, sample_wav, monkeypatch, COMMENTER)
    assert second == first

    retime = {"id": old.id, "start": 6.0, "end": 6.5, "snap": False}
    assert not submit(second, "UpdatePendingEdit", retime)
    assert submit(second, "SuggestPendingEdit", {"track_id": "c", "start": 7.0, "end": 7.5})
    authors = (edit_at(minimal_project, 5.0).author, edit_at(minimal_project, 7.0).author)
    assert authors == (old.author, registry_author(second))
    assert old.author != registry_author(second)


@pytest.mark.parametrize(
    ("role", "command_type"),
    [
        ("commenter", "SuggestPendingEdit"),
        ("commenter", "UpdatePendingEdit"),
        ("editor", "ApproveEdits"),
        ("editor", "EditSelectedRange"),
    ],
)
def test_document_commands_need_view(role, command_type):
    caps = capabilities_for_role(role, with_mcp=True)
    with pytest.raises(PermissionError, match=command_type):
        authorize_document_command([cap for cap in caps if cap != "view"], command_type)
    authorize_document_command(caps, command_type)


def _mcp_share(minimal_project, sample_wav, monkeypatch, caps: list[str]) -> str:
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


@pytest.mark.parametrize("role", ["commenter", "editor"])
def test_guest_mcp_needs_view_like_the_browser(minimal_project, sample_wav, monkeypatch, role):
    pending_project(minimal_project)
    suggest = {
        "type": "SuggestPendingEdit",
        "payload": {"track_id": "c", "start": 5.0, "end": 5.5},
    }
    caps = capabilities_for_role(role, with_mcp=True)
    blind_caps = [cap for cap in caps if cap != "view"]
    blind = _mcp_share(minimal_project, sample_wav, monkeypatch, blind_caps)
    assert "guest_submit_document_command" not in tools_for_capabilities(blind_caps)
    denied = _mcp_call(blind, "guest_submit_document_command", suggest)
    assert "error" in denied
    assert len(load_project(minimal_project).edit_decisions) == 3

    seeing = _mcp_share(minimal_project, sample_wav, monkeypatch, caps)
    allowed = _mcp_call(seeing, "guest_submit_document_command", suggest)
    assert "error" not in allowed, allowed
    assert json.loads(allowed["result"]["content"][0]["text"])["ok"] is True
    assert len(load_project(minimal_project).edit_decisions) == 4


@pytest.mark.parametrize(
    ("caps", "offered"),
    [
        ([*(cap for cap in EDITOR if cap != "view"), "mcp"], set()),
        ([*COMMENTER, "mcp"], set()),
        ([*EDITOR, "mcp"], {"render", "upload"}),
    ],
    ids=["editor-without-view", "commenter", "editor"],
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
    for index, track in enumerate(ws.project.tracks):
        path = ws.project.raw_dir() / f"{track.id}.wav"
        write_wav(path, room(seconds=35, seed=1700 + index))
        track.media = MediaAsset(path=f"raw/{track.id}.wav", duration_sec=35)
    save_project(ws.project)
    return DocumentSyncService.open(minimal_project)


@pytest.mark.parametrize("action", ["cut", "mute"])
@pytest.mark.parametrize(
    ("caps", "range_policy", "outcome"),
    [
        (VIEWER, "apply", None),
        (VIEWER, "propose", None),
        (SUGGEST_ONLY, "apply", None),
        (COMMENTER, "apply", "guest:suggest"),
        (COMMENTER, "propose", "guest:suggest"),
        (EDITOR, "apply", "applied"),
        (EDITOR, "propose", "applied"),
        (None, "apply", "applied"),
        (None, "propose", "agent:range"),
    ],
    ids=[
        "viewer-daw",
        "viewer-mcp",
        "suggest-only-daw",
        "commenter-daw",
        "commenter-mcp",
        "editor-daw",
        "editor-mcp",
        "host-daw",
        "host-agent",
    ],
)
def test_selected_range_mode_follows_the_role_on_every_surface(
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
    """One exact selected-range and one source suggestion, both from a Commenter."""
    exact = command(target(svc.ws.project))
    svc.submit(exact, capabilities=COMMENTER, range_policy="apply")
    svc.submit(
        guest_command("SuggestPendingEdit", {"track_id": "c", "start": 15.0, "end": 15.5}),
        capabilities=COMMENTER,
        range_policy="apply",
    )
    source = next(e.id for e in svc.ws.project.edit_decisions if e.exact_range is None)
    return {"exact": exact.command_id, "source": source}


@pytest.mark.parametrize("kind", ["exact", "source"])
@pytest.mark.parametrize("decide", ["ApproveEdits", "RejectEdits"])
@pytest.mark.parametrize("range_policy", ["apply", "propose"], ids=["daw", "mcp"])
@pytest.mark.parametrize(
    ("caps", "allowed"),
    [(VIEWER, False), (COMMENTER, False), (EDITOR, True)],
    ids=["viewer", "commenter", "editor"],
)
def test_only_editors_decide_pending_suggestions(
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
            type="UndoHistory",
            payload=history_move(minimal_project),
            client_id="host",
            client_seq=None,
            role="viewer",
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
def test_host_undoes_each_editor_mcp_change(minimal_project, change):
    svc = range_project(minimal_project)
    ids = suggest_both_kinds(svc)
    host = append_remove_decision(
        svc.ws.project, "c", 1.0, 1.5, reason="", defaults=load_defaults()
    )
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
    svc.submit(commands[change], capabilities=EDITOR, range_policy="propose")
    assert saved_state(minimal_project) != before
    host_undo(minimal_project)
    assert saved_state(minimal_project) == before


@pytest.mark.parametrize(
    ("caps", "outcome"),
    [
        ([*COMMENTER, "mcp"], "proposed"),
        ([*EDITOR, "mcp"], "applied"),
    ],
    ids=["commenter", "editor"],
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
        [proposal] = project.edit_decisions
        assert proposal.reason == "guest:suggest"
        assert proposal.boundary_intent == "programmatic"
        assert project.clips == before


@pytest.fixture
def guest_read_routes(minimal_project, sample_wav, published_share):
    """Guest GET routes that read for one document command, keyed by share capabilities."""
    from unittest.mock import patch

    from podcast_mcp.engines.waveform_pyramid import wait_pyramid_jobs
    from podcast_mcp.services.document import EpisodeService

    ws = ProjectWorkspace.open(minimal_project)
    EpisodeService(ws).add_track("host", str(sample_wav), speaker="Host", role="music")
    wait_pyramid_jobs()
    ws.project.edit_decisions = [
        EditDecision(id="pending", track_id="host", start=2, end=8, applied=False)
    ]
    save_project(ws.project, minimal_project)
    client = TestClient(create_app())

    def get(route: str, caps: list[str]) -> int:
        _, _, share = published_share(capabilities=caps)
        base = f"/api/review/{share['token']}/daw"
        with (
            patch(
                "podcast_mcp.edits.inaudible_cuts._snap_boundary_to_waveform",
                side_effect=[1.975, 8.035],
            ),
            patch(
                "podcast_mcp.services.document.analysis.AnalysisService.preview_inaudible_cut",
                return_value={"start": 0.1, "end": 0.2, "mode": "x"},
            ),
        ):
            if route == "snap":
                response = client.get(
                    f"{base}/waveform-snap",
                    params={"track_id": "host", "start": 0.0, "end": 0.4},
                )
            else:
                response = client.get(f"{base}/pending-edits/pending/cut-suggestion")
        return response.status_code

    return get


@pytest.mark.parametrize("route", ["snap", "cut-suggestion"])
@pytest.mark.parametrize(
    ("caps", "status"),
    [
        (LISTEN, 403),
        (VIEWER, 403),
        (COMMENTER, 200),
        (EDITOR, 200),
        (SUGGEST_ONLY, 403),
        (["play", "suggest"], 403),
        ([cap for cap in EDITOR if cap != "view"], 403),
    ],
    ids=[
        "listen",
        "viewer",
        "commenter",
        "editor",
        "suggest-only",
        "suggest-without-view",
        "editor-without-view",
    ],
)
def test_guest_authoring_reads_follow_the_gate(guest_read_routes, route, caps, status):
    assert guest_read_routes(route, caps) == status


def gap_project(minimal_project, monkeypatch) -> DocumentSyncService:
    from pause_policy_public_helpers import add_bed, configure, defaults, project
    from podcast_mcp.models import Clip

    configure(monkeypatch, defaults())
    root = minimal_project.parent
    result = project(root)
    result.tracks[0].speaker = "Host"
    add_bed(result, root)
    result.clips = [
        Clip(id="left", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="right", track_id="host", source_start=2, source_end=6, timeline_start=2.0),
    ]
    save_project(result, minimal_project)
    return DocumentSyncService.open(minimal_project)


def fill_command(payload: dict) -> DocumentCommand:
    return guest_command("FillRoomTone", payload)


def journal_types(minimal_project) -> list[str]:
    return [r["type"] for r in DocumentSyncService.open(minimal_project).store.commands_after(0)]


def history_total(minimal_project) -> int:
    from podcast_mcp.mcp.tools.history import history_status_tool

    return json.loads(history_status_tool(str(minimal_project)))["total"]


NO_RANGE = {"track_id": "host"}
RANGE = {"track_id": "host", "start_sec": 1.0, "end_sec": 2.0}


@pytest.mark.parametrize("caps", [EDITOR, [*EDITOR, "mcp"]], ids=["editor", "editor-mcp"])
@pytest.mark.parametrize("payload", [NO_RANGE, {"speaker": "Host"}])
def test_editor_room_tone_fill_without_a_range_is_host_only(
    minimal_project, monkeypatch, caps, payload
):
    svc = gap_project(minimal_project, monkeypatch)
    before = deepcopy(svc.ws.project.clips)
    total = history_total(minimal_project)
    with pytest.raises(PermissionError) as raised:
        svc.submit(fill_command(payload), capabilities=caps)
    assert raised.value.code == "share_capability_required"
    assert load_project(minimal_project).clips == before
    assert history_total(minimal_project) == total
    assert journal_types(minimal_project) == []


@pytest.mark.parametrize("payload", [{"track_id": "host", "start_sec": 1.0}])
def test_editor_half_a_range_room_tone_fill_is_refused_as_a_permission(
    minimal_project, monkeypatch, payload
):
    svc = gap_project(minimal_project, monkeypatch)
    with pytest.raises(PermissionError) as raised:
        svc.submit(fill_command(payload), capabilities=EDITOR)
    assert raised.value.code == "share_capability_required"
    assert journal_types(minimal_project) == []


@pytest.mark.parametrize("caps", [EDITOR, [*EDITOR, "mcp"]], ids=["editor", "editor-mcp"])
def test_editor_range_room_tone_fill_still_runs(minimal_project, monkeypatch, caps):
    svc = gap_project(minimal_project, monkeypatch)
    before = deepcopy(svc.ws.project.clips)
    svc.submit(fill_command(RANGE), capabilities=caps)
    assert load_project(minimal_project).clips != before
    assert journal_types(minimal_project) == ["FillRoomTone"]


def test_host_room_tone_fill_without_a_range_passes(minimal_project, monkeypatch):
    svc = gap_project(minimal_project, monkeypatch)
    before = deepcopy(svc.ws.project.clips)
    svc.submit(fill_command(NO_RANGE), capabilities=None)
    assert load_project(minimal_project).clips != before
    assert journal_types(minimal_project) == ["FillRoomTone"]


@pytest.mark.parametrize("caps", [VIEWER, COMMENTER], ids=["viewer", "commenter"])
@pytest.mark.parametrize("payload", [NO_RANGE, RANGE], ids=["no-range", "range"])
def test_commenter_and_viewer_room_tone_fill_is_refused(
    minimal_project, monkeypatch, caps, payload
):
    svc = gap_project(minimal_project, monkeypatch)
    with pytest.raises(PermissionError, match="FillRoomTone"):
        svc.submit(fill_command(payload), capabilities=caps)
    assert journal_types(minimal_project) == []


@pytest.mark.parametrize("surface", ["browser", "mcp"])
def test_room_tone_fill_shape_gate_holds_on_every_guest_surface(
    minimal_project, sample_wav, monkeypatch, surface
):
    svc = gap_project(minimal_project, monkeypatch)
    before = deepcopy(svc.ws.project.clips)
    token = _mcp_share(minimal_project, sample_wav, monkeypatch, [*EDITOR, "mcp"])
    total = history_total(minimal_project)
    submit = guest_submitter(surface)
    assert not submit(token, "FillRoomTone", NO_RANGE)
    assert load_project(minimal_project).clips == before
    assert history_total(minimal_project) == total
    assert journal_types(minimal_project) == []
    assert submit(token, "FillRoomTone", RANGE)
    assert load_project(minimal_project).clips != before
    assert journal_types(minimal_project) == ["FillRoomTone"]


PLAN = {"edits": [{"track_id": "host", "start": 2.2, "end": 2.8, "applied": True}]}
AUTOMATION = {
    "ApplyAutoEdits": {},
    "ApplyEditPlan": PLAN,
    "ShortenWordGaps": {"max_gap_sec": 0.35},
    "StripSilence": {"track_id": "host"},
    "ProposeTighten": {},
}
NON_EDITOR = [VIEWER, COMMENTER, [*COMMENTER, "mcp"]]
NON_EDITOR_IDS = ["viewer", "commenter", "commenter-mcp"]


@pytest.mark.parametrize("command_type", AUTOMATION)
@pytest.mark.parametrize("caps", NON_EDITOR, ids=NON_EDITOR_IDS)
def test_automation_command_is_refused_below_editor(
    minimal_project, monkeypatch, command_type, caps
):
    svc = gap_project(minimal_project, monkeypatch)
    before = deepcopy(svc.ws.project)
    total = history_total(minimal_project)
    with pytest.raises(PermissionError) as raised:
        svc.submit(guest_command(command_type, AUTOMATION[command_type]), capabilities=caps)
    assert raised.value.code == "share_capability_required"
    assert load_project(minimal_project).clips == before.clips
    assert load_project(minimal_project).edit_decisions == before.edit_decisions
    assert history_total(minimal_project) == total
    assert journal_types(minimal_project) == []


@pytest.mark.parametrize("command_type", AUTOMATION)
@pytest.mark.parametrize(
    "caps", [None, EDITOR, [*EDITOR, "mcp"]], ids=["host", "editor", "editor-mcp"]
)
def test_automation_command_runs_for_the_editor_as_for_the_host(
    minimal_project, monkeypatch, command_type, caps
):
    svc = gap_project(minimal_project, monkeypatch)
    svc.submit(guest_command(command_type, AUTOMATION[command_type]), capabilities=caps)
    assert journal_types(minimal_project) == [command_type]


@pytest.mark.parametrize("command_type", AUTOMATION)
@pytest.mark.parametrize("surface", ["browser", "mcp"])
def test_automation_command_follows_the_role_on_every_guest_surface(
    minimal_project, sample_wav, monkeypatch, surface, command_type
):
    gap_project(minimal_project, monkeypatch)
    token = _mcp_share(minimal_project, sample_wav, monkeypatch, [*COMMENTER, "mcp"])
    assert not guest_submitter(surface)(token, command_type, AUTOMATION[command_type])
    assert journal_types(minimal_project) == []
    editor = _mcp_share(minimal_project, sample_wav, monkeypatch, [*EDITOR, "mcp"])
    assert guest_submitter(surface)(editor, command_type, AUTOMATION[command_type])
    assert journal_types(minimal_project) == [command_type]


EDITOR_PARITY_COMMANDS = [
    "AddChapter",
    "AddEffect",
    "AddSocialClip",
    "ApplyAutoEdits",
    "ApplyEditPlan",
    "ApplyFadeRecommendationList",
    "ApplyTranscriptCleanup",
    "CorrectTranscriptPhrase",
    "CorrectTranscriptWord",
    "CrossfadeJoins",
    "DeleteChapter",
    "DeleteSocialClip",
    "FadeJoins",
    "InsertGap",
    "MoveByText",
    "ProposeTighten",
    "ReconcileTranscript",
    "RemoveEffect",
    "RenameProject",
    "ReplaceTranscriptMatches",
    "RestoreClipBleed",
    "RippleDeleteText",
    "SetBleedAlignmentMode",
    "SetTranscriptWordAutomatic",
    "SetTranscriptWordSuppressed",
    "SetTranscriptWordTiming",
    "SetTranscriptWordsIgnored",
    "ShortenWordGaps",
    "StageTextMatchCut",
    "StageTimeRangeCut",
    "StageUtteranceCut",
    "StageWordsCut",
    "StripSilence",
    "SuppressBleed",
    "SuppressLowAudibility",
    "UpdateChapter",
    "UpdateSocialClip",
    "VerifyTranscript",
]


@pytest.mark.parametrize("command_type", EDITOR_PARITY_COMMANDS)
def test_editor_parity_command_gate(command_type):
    authorize_document_command(EDITOR, command_type)
    authorize_document_command([*EDITOR, "mcp"], command_type)
    for caps in (COMMENTER, [*COMMENTER, "mcp"], VIEWER):
        with pytest.raises(PermissionError) as raised:
            authorize_document_command(caps, command_type)
        assert raised.value.code == "share_capability_required"


def test_every_document_command_is_classified():
    every = set(get_args(DocumentCommandType))
    classified = EDIT_COMMANDS | SUGGEST_COMMANDS | COMMENT_COMMANDS | HOST_ONLY_DOCUMENT_COMMANDS
    assert every - classified == set()
    assert classified - every == set()
    assert HOST_ONLY_DOCUMENT_COMMANDS.isdisjoint(EDIT_COMMANDS | SUGGEST_COMMANDS)


def test_the_editor_holds_every_command_the_host_runs_but_the_named_host_only_ones():
    editor = document_command_types_for_caps(EDITOR)
    every = set(get_args(DocumentCommandType))
    assert every - editor == COMMENT_COMMANDS | HOST_ONLY_DOCUMENT_COMMANDS


@pytest.mark.parametrize("caps", [EDITOR, [*EDITOR, "mcp"]], ids=["editor", "editor-mcp"])
def test_an_editor_effect_cannot_name_a_host_model_file(caps):
    authorize_document_payload(caps, "AddEffect", {"track_id": "host", "effect": "arnndn"})
    authorize_document_payload(
        caps, "AddEffect", {"track_id": "host", "effect": "highpass", "params": {"frequency": 80}}
    )
    for params in ({"model": "/etc/passwd"}, {"model": ""}):
        with pytest.raises(PermissionError) as raised:
            authorize_document_payload(
                caps, "AddEffect", {"track_id": "host", "effect": "arnndn", "params": params}
            )
        assert raised.value.code == "share_capability_required"
    authorize_document_payload(
        None, "AddEffect", {"track_id": "host", "effect": "arnndn", "params": {"model": "/m"}}
    )


@pytest.mark.parametrize("params", [3, "x", ["a"]])
def test_an_editor_effect_with_non_object_params_is_refused_with_a_code(params):
    with pytest.raises(CodedValueError) as raised:
        authorize_document_payload(
            EDITOR, "AddEffect", {"track_id": "host", "effect": "highpass", "params": params}
        )
    assert raised.value.code == "invalid_effect_params"


@pytest.mark.parametrize("effect", [5, ["highpass"], {"a": 1}])
def test_an_editor_effect_name_that_is_not_a_string_is_refused_with_a_code(effect):
    with pytest.raises(CodedValueError) as raised:
        authorize_document_payload(EDITOR, "AddEffect", {"track_id": "host", "effect": effect})
    assert raised.value.code == "invalid_effect_params"


def test_an_editor_effect_param_too_large_for_a_float_is_refused_with_a_code():
    with pytest.raises(CodedValueError) as raised:
        authorize_document_payload(
            EDITOR,
            "AddEffect",
            {"track_id": "host", "effect": "highpass", "params": {"frequency": 10**400}},
        )
    assert raised.value.code == "invalid_effect_params"


@pytest.mark.parametrize("model", ["/m,ametadata=mode=print", "/m;amovie=/x", "/m[a]", "a]b"])
def test_validate_effect_params_refuses_filter_syntax_in_a_model(model):
    with pytest.raises(CodedValueError) as raised:
        validate_effect_params("arnndn", {"model": model})
    assert raised.value.code == "invalid_effect_params"


@pytest.mark.parametrize("params", [["a"], "x", 3])
def test_validate_effect_params_refuses_params_that_are_not_an_object(params):
    with pytest.raises(CodedValueError) as raised:
        validate_effect_params("highpass", params)
    assert raised.value.code == "invalid_effect_params"


INJECTIONS = [
    ("equalizer", {"f": "3,ametadata=mode=print:file=/tmp/x"}),
    ("equalizer", {"t": "q[a];amovie=/x[b];[a][b]amix"}),
    ("acompressor", {"ratio": "3,ametadata=mode=print:file=/tmp/x"}),
    ("highpass", {"frequency": "80;amovie=/x"}),
    ("equalizer", {"g": float("nan")}),
    ("equalizer", {"t": "z"}),
    ("equalizer", {"f": True}),
    ("equalizer", {"gain": 3}),
    ("loudnorm", {"integrated_lufs": 5}),
]


@pytest.mark.parametrize("caps", [EDITOR, [*EDITOR, "mcp"]], ids=["editor", "editor-mcp"])
@pytest.mark.parametrize(("effect", "params"), INJECTIONS)
def test_an_editor_effect_param_cannot_inject_a_filter(caps, effect, params):
    payload = {"track_id": "host", "effect": effect, "params": params}
    with pytest.raises(CodedValueError) as raised:
        authorize_document_payload(caps, "AddEffect", payload)
    assert raised.value.code == "invalid_effect_params"


@pytest.mark.parametrize(("effect", "params"), INJECTIONS)
def test_the_host_service_refuses_an_unsafe_effect_param(
    minimal_project, monkeypatch, effect, params
):
    svc = gap_project(minimal_project, monkeypatch)
    before = journal_types(minimal_project)
    command = DocumentCommand(
        type="AddEffect",
        payload={"track_id": "host", "effect": effect, "params": params},
        client_id="host",
        client_seq=None,
        role="agent",
    )
    with pytest.raises(CodedValueError) as raised:
        svc.submit(command)
    assert raised.value.code == "invalid_effect_params"
    assert load_project(minimal_project).processing_chains == []
    assert journal_types(minimal_project) == before


def test_valid_effect_params_still_render_a_filter():
    params = {"f": "1000", "t": "h", "w": 2, "g": -3.5}
    authorize_document_payload(
        EDITOR, "AddEffect", {"track_id": "host", "effect": "equalizer", "params": params}
    )
    assert format_effect("equalizer", params) == "equalizer=f=1000:t=h:w=2:g=-3.5"
    assert format_effect("highpass", {"frequency": 90.0}) == "highpass=f=90"
    assert format_effect("equalizer", {}) == "equalizer=f=1000:t=q:w=1.0:g=0"
