from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from threading import Barrier
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from podcast_mcp.edits.decisions import PendingEditBaseline, PendingEditChangedError
from podcast_mcp.edits.share_capabilities import capabilities_for_role
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    MediaAsset,
    Track,
    TrackRole,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService, HistoryService
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.document_sync.payloads import UpdatePendingEditPayload

BASELINE = PendingEditBaseline("host", EditDecisionType.REMOVE, "source", 2.0, 8.0)


@pytest.fixture
def pending_project(minimal_project):
    project = load_project(minimal_project)
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.MUSIC,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        )
    ]
    project.clips = [
        Clip(id="clip", track_id="host", source_start=0, source_end=10, timeline_start=0)
    ]
    project.edit_decisions = [
        EditDecision(id="pending", track_id="host", start=2, end=8, applied=False)
    ]
    save_project(project, minimal_project)
    return minimal_project


def _command(*, expected=BASELINE, command_id="accept-suggestion", client_seq=1):
    return DocumentCommand(
        type="UpdatePendingEdit",
        payload={
            "id": "pending",
            "start": 1.97525,
            "end": 8.03525,
            "snap": False,
            **({"expected": asdict(expected)} if expected is not None else {}),
        },
        client_id="reviewer",
        role="viewer",
        client_seq=client_seq,
        command_id=command_id,
    )


def test_acceptance_uses_exact_bounds_once_and_one_undo_restores_them(pending_project):
    service = DocumentSyncService.open(pending_project)
    command = _command()
    with patch("podcast_mcp.edits.decisions.optimize_source_cut_range") as optimize:
        reply = service.submit(command)
        before_retry = pending_project.read_bytes()
        history = HistoryService(ProjectWorkspace.open(pending_project)).list_entries()
        retry = service.submit(command)
    assert reply["ok"] is True
    assert retry["idempotent"] is True
    assert pending_project.read_bytes() == before_retry
    assert HistoryService(ProjectWorkspace.open(pending_project)).list_entries() == history
    edit = load_project(pending_project).edit_decisions[0]
    assert (edit.start, edit.end) == (1.97525, 8.03525)
    optimize.assert_not_called()
    HistoryService(ProjectWorkspace.open(pending_project)).undo(rerender=False)
    edit = load_project(pending_project).edit_decisions[0]
    assert (edit.start, edit.end) == (2, 8)


@pytest.mark.parametrize(
    "change",
    [
        {"start": 2.25},
        {"end": 9},
        {"track_id": "guest"},
        {"type": EditDecisionType.MUTE},
        {"timebase": "timeline"},
        {"applied": True},
        None,
    ],
)
def test_guard_reloads_saved_target_and_rejects_changes_before_history(pending_project, change):
    workspace = ProjectWorkspace.open(pending_project)
    project = load_project(pending_project)
    project.edit_decisions = (
        [project.edit_decisions[0].model_copy(update=change)] if change is not None else []
    )
    save_project(project, pending_project)
    before = pending_project.read_bytes()
    history = HistoryService(ProjectWorkspace.open(pending_project)).list_entries()
    with pytest.raises(PendingEditChangedError, match="changed since you reviewed"):
        EditService(workspace).update_pending(
            "pending", start=1.97525, end=8.03525, snap=False, expected=BASELINE
        )
    assert pending_project.read_bytes() == before
    assert HistoryService(ProjectWorkspace.open(pending_project)).list_entries() == history


def test_stale_command_creates_no_journal_or_history_entry(pending_project):
    service = DocumentSyncService.open(pending_project)
    EditService(ProjectWorkspace.open(pending_project)).update_pending(
        "pending", start=2, end=9, snap=False
    )
    service.document_snapshot()
    before = pending_project.read_bytes()
    journal = service.store.get_snapshot()
    history = HistoryService(ProjectWorkspace.open(pending_project)).list_entries()
    with pytest.raises(DocumentConflictError, match="changed since you reviewed"):
        service.submit(_command())
    assert pending_project.read_bytes() == before
    assert service.store.get_snapshot() == journal
    assert HistoryService(ProjectWorkspace.open(pending_project)).list_entries() == history


def test_unconditional_nudge_remains_available(pending_project):
    service = DocumentSyncService.open(pending_project)
    EditService(ProjectWorkspace.open(pending_project)).update_pending(
        "pending", start=2, end=9, snap=False
    )
    reply = service.submit(_command(expected=None))
    assert reply["ok"] is True
    edit = load_project(pending_project).edit_decisions[0]
    assert (edit.start, edit.end) == (1.97525, 8.03525)


@pytest.mark.parametrize("kind", [EditDecisionType.MUTE, EditDecisionType.SPLIT])
def test_matching_baseline_supports_other_pending_edit_workflows(pending_project, kind):
    project = load_project(pending_project)
    edit = project.edit_decisions[0]
    edit.type = kind
    if kind == EditDecisionType.SPLIT:
        edit.timebase = "timeline"
        edit.end = edit.start
    save_project(project, pending_project)
    baseline = PendingEditBaseline(
        "host",
        kind,
        "timeline" if kind == EditDecisionType.SPLIT else "source",
        edit.start,
        edit.end,
    )
    updated = EditService(ProjectWorkspace.open(pending_project)).update_pending(
        "pending", start=3, end=7, snap=False, expected=baseline
    )
    assert updated.start == 3
    assert updated.end == (3 if kind == EditDecisionType.SPLIT else 7)


def test_concurrent_editors_with_one_baseline_have_one_winner(pending_project):
    barrier = Barrier(2)

    def update(end):
        workspace = ProjectWorkspace.open(pending_project)
        barrier.wait(timeout=10)
        try:
            EditService(workspace).update_pending(
                "pending", start=2, end=end, snap=False, expected=BASELINE
            )
        except PendingEditChangedError:
            return "conflict"
        return end

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(update, [8.25, 8.5]))
    assert outcomes.count("conflict") == 1
    winner = next(outcome for outcome in outcomes if outcome != "conflict")
    assert load_project(pending_project).edit_decisions[0].end == winner


@pytest.mark.parametrize("guest", [False, True])
def test_stale_http_command_replay_returns_conflict_and_keeps_newer_edit(
    pending_project, published_share, guest
):
    client = TestClient(create_app())
    if guest:
        # An Editor may retime the host's pending edit; a Commenter is refused by
        # the permission gate before any staleness check (#1005).
        _, _, share = published_share(capabilities=capabilities_for_role("editor"))
        url = f"/api/review/{share['token']}/daw/document/command"
    else:
        url = f"/api/document/command?path={pending_project}"
    EditService(ProjectWorkspace.open(pending_project)).update_pending(
        "pending", start=2, end=9, snap=False
    )
    body = _command().to_row()
    before = pending_project.read_bytes()
    for _ in range(2):
        response = client.post(url, json=body)
        assert response.status_code == 409
        assert response.json()["detail"]["conflict"] is True
        assert "changed since you reviewed" in response.json()["detail"]["detail"]
        assert pending_project.read_bytes() == before
    current = PendingEditBaseline("host", EditDecisionType.REMOVE, "source", 2, 9)
    valid = _command(expected=current, command_id="reviewed-new-bounds", client_seq=2)
    assert client.post(url, json=valid.to_row()).status_code == 200


@pytest.mark.parametrize(
    "change",
    [
        {"track_id": ""},
        {"type": "invalid"},
        {"timebase": "invalid"},
        {"start": -1},
        {"end": float("inf")},
        {"start": float("nan")},
    ],
)
def test_baseline_payload_rejects_invalid_identity_and_bounds(change):
    with pytest.raises(ValidationError):
        UpdatePendingEditPayload.model_validate(
            {**_command().payload, "expected": {**asdict(BASELINE), **change}}
        )
