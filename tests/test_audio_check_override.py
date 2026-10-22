"""The owner's audio-check override works from every surface and is recorded (#1741)."""

from __future__ import annotations

import json

import pytest

from pause_policy_public_helpers import workspace
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.mcp.tools.edits import approve_edits_tool
from podcast_mcp.mcp.tools.timeline import ripple_delete_text_tool
from podcast_mcp.models import TranscriptWord, load_project, save_project
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from test_approve_guard_blocked_ripple import _blocked_filler
from test_edit_modes import episode as _episode_fixture

episode = _episode_fixture


def _override_record(path):
    (record,) = load_project(path).editorial.edit_log
    return record.params["audio_check_override"]


def test_host_mcp_approve_all_reports_held_then_override_applies_and_records(tmp_path, monkeypatch):
    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)

    held = json.loads(approve_edits_tool(str(ws.path), all_pending=True))
    assert held["approved_count"] == 0
    assert [h["id"] for h in held["held"]] == [decision.id]
    assert "override_audio_checks=true" in held["apply_anyway"]
    assert load_project(ws.path).editorial.edit_log == []

    done = json.loads(
        approve_edits_tool(str(ws.path), all_pending=True, override_audio_checks=True)
    )
    assert done["approved_count"] == 1
    # approve_edits_tool is a document command with the default role, so its surface is "agent".
    assert _override_record(ws.path) == {
        "kind": "owner_override",
        "actor": "mcp:host",
        "surface": "agent",
    }


def test_host_mcp_ripple_delete_text_override_records_the_host_mcp_surface(episode):
    project = load_project(episode)
    host = next(t for t in project.transcripts if t.track_id == "host")
    host.words.append(TranscriptWord(text="um", start=10.0, end=11.0))
    save_project(project)

    held = json.loads(ripple_delete_text_tool(str(episode), "um"))
    assert load_project(episode).editorial.edit_log == []
    assert held["unchanged"] is True

    ripple_delete_text_tool(str(episode), "um", override_audio_checks=True)

    assert _override_record(episode) == {
        "kind": "owner_override",
        "actor": "mcp:host",
        "surface": "host_mcp",
    }


def test_host_mcp_approve_needs_ids_or_all(tmp_path, monkeypatch):
    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)
    for kwargs in ({}, {"ids": [decision.id], "all_pending": True}):
        with pytest.raises(ValueError, match="ids or all_pending"):
            approve_edits_tool(str(ws.path), **kwargs)


def test_host_mcp_held_edit_is_listed_with_its_finding_and_the_override(tmp_path, monkeypatch):
    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)
    before = ws.project.model_dump(mode="json")

    reply = json.loads(approve_edits_tool(str(ws.path), [decision.id]))

    assert reply["approved_count"] == 0
    assert [row["id"] for row in reply["held"]] == [decision.id]
    assert "Guest is speaking" in reply["held"][0]["reason"]
    assert "override_audio_checks=true" in reply["apply_anyway"]
    assert ws.project.model_dump(mode="json") == before


@pytest.mark.parametrize("role", ["guest", "agent", "cli"])
def test_document_command_override_works_for_every_role_and_records_actor(
    tmp_path, monkeypatch, role
):
    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)
    svc = DocumentSyncService.open(ws.path)

    def submit(seq: int, override: bool):
        return svc.submit(
            DocumentCommand(
                type="ApproveEdits",
                payload={"ids": [decision.id], "override_audio_checks": override},
                client_id=f"{role}-1",
                role=role,
                client_seq=seq,
            ),
            author="share:abc" if role == "guest" else None,
        )

    with pytest.raises(ScopeChangedAtApproval):
        submit(1, False)
    assert load_project(ws.path).editorial.edit_log == []

    assert submit(2, True)["ok"]
    assert _override_record(ws.path) == {
        "kind": "owner_override",
        "actor": "share:abc" if role == "guest" else f"{role}-1",
        "surface": role,
    }


def test_suggested_preview_plays_a_held_cut_as_approving_it_anyway_would(tmp_path, monkeypatch):
    from podcast_mcp.edits.pending_preview import apply_for_suggested, resolve_pending_preview

    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)
    saved = ws.path.read_bytes()
    snapshot = ws.project.model_copy(deep=True)

    end = apply_for_suggested(
        snapshot, resolve_pending_preview(snapshot, decision.id), defaults=load_defaults()
    )

    assert end > 0
    assert len(snapshot.editorial.edit_log) == 1
    assert ws.path.read_bytes() == saved


def test_share_override_needs_the_editor_capability(tmp_path, monkeypatch):
    from podcast_mcp.services.collaboration.share_capabilities import (
        REVIEW_ROLE_CAPABILITIES,
        ReviewRole,
    )
    from podcast_mcp.util.coded_error import CodedPermissionError

    result, _decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)
    svc = DocumentSyncService.open(ws.path)

    def submit(caps, seq):
        return svc.submit(
            DocumentCommand(
                type="DeleteClip",
                payload={
                    "clip_ids": [ws.project.clips[0].id],
                    "mode": "gap",
                    "override_audio_checks": True,
                },
                client_id="guest-1",
                role="guest",
                client_seq=seq,
            ),
            capabilities=list(caps),
            author="share:abc",
        )

    with pytest.raises(CodedPermissionError, match="Editor capability"):
        submit(REVIEW_ROLE_CAPABILITIES[ReviewRole.COMMENTER], 1)
    assert load_project(ws.path).editorial.edit_log == []
    assert submit(REVIEW_ROLE_CAPABILITIES[ReviewRole.EDITOR], 2)["ok"]
    (record,) = load_project(ws.path).editorial.edit_log
    assert record.params["audio_check_override"]["actor"] == "share:abc"


def test_override_keeps_pending_update_bounds_exactly_as_given(tmp_path, monkeypatch):
    from podcast_mcp.edits.audio_check_override import audio_check_override
    from podcast_mcp.services.document import EditService

    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)
    start, end = decision.start + 0.013, decision.end - 0.017

    with audio_check_override("mcp:host", "host_mcp"):
        edit = EditService(ws).update_pending(decision.id, start=start, end=end, snap=True)

    assert (edit.start, edit.end) == (start, end)


def test_held_listing_names_holds_even_when_a_neighbour_refuses_the_batch(tmp_path, monkeypatch):
    from podcast_mcp.edits import cut_application
    from podcast_mcp.edits.cut_placement import CutScopeHold
    from podcast_mcp.services.document import EditService

    result, decision = _blocked_filler(tmp_path, monkeypatch)
    ws = workspace(result)

    def refuse(project, ids, **_kwargs):
        raise ScopeChangedAtApproval(
            [CutScopeHold(decision.id, (), "acoustic_edge", detail="breath_edge")], {}
        )

    monkeypatch.setattr(cut_application, "approve_edits", refuse)

    held, asked = EditService(ws).held_by_checks()

    assert [(h.edit_id, "breath" in h.reason) for h in held] == [(decision.id, True)]
    assert asked == []
