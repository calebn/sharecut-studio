from __future__ import annotations

from copy import deepcopy

import pytest
from pydantic import ValidationError

from podcast_mcp.edits.decisions import approve_edits, update_pending_edit
from podcast_mcp.edits.range_edits import (
    RangeChangedError,
    edit_selected_range,
    range_geometry,
    range_media_seal,
)
from podcast_mcp.models import Clip, EpisodeProject, Track, load_project, save_project
from podcast_mcp.models.episode import ExactRangeTarget, RangeInterval
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.document_sync import (
    DocumentCommand,
    DocumentSyncService,
    validate_payload,
)
from podcast_mcp.services.document_sync.errors import DocumentConflictError


def fixture(project):
    project.tracks = [Track(id=t, label=t) for t in ["a", "b", "c"]]
    project.clips = [
        Clip(id="first", track_id="a", source_start=0, source_end=5, timeline_start=0),
        Clip(id="repeat", track_id="a", source_start=0, source_end=5, timeline_start=10),
        Clip(id="overlap", track_id="a", source_start=20, source_end=23, timeline_start=11),
        Clip(id="moved", track_id="b", source_start=30, source_end=35, timeline_start=10),
        Clip(id="other", track_id="c", source_start=0, source_end=20, timeline_start=0),
    ]
    project.timeline.duration_sec = 20
    return project


def target(project, intervals=((11, 12), (13, 14)), tracks=("a", "b")):
    spans = [RangeInterval(start=a, end=b) for a, b in intervals]
    return ExactRangeTarget(
        intervals=spans,
        track_ids=list(tracks),
        clips=range_geometry(project, spans, list(tracks)),
        media_seals={t: range_media_seal(project, t) for t in tracks},
    )


def spans(project, tid):
    return sorted(
        (c.source_start, c.source_end, c.timeline_start) for c in project.clips if c.track_id == tid
    )


def apply(project, selection, action="cut", propose=False):
    return edit_selected_range(
        project, selection, action, propose=propose, reason="host:range", action_id="range_action"
    )


def test_exact_cut_keeps_repeated_source_unselected_tracks_and_gaps(tmp_path):
    project = fixture(EpisodeProject.create("range", str(tmp_path)))
    first, other = deepcopy(project.clips[0]), deepcopy(project.clips[-1])
    apply(project, target(project))
    assert spans(project, "a") == [(0, 1, 10), (0, 5, 0), (2, 3, 12), (4, 5, 14), (21, 22, 12)]
    assert spans(project, "b") == [(30, 31, 10), (32, 33, 12), (34, 35, 14)]
    assert next(c for c in project.clips if c.id == "first") == first
    assert next(c for c in project.clips if c.id == "other") == other
    assert project.timeline.duration_sec == 20
    assert project.editorial.edit_log[-1].params["action_id"] == "range_action"


def test_mute_is_local_to_occurrence(tmp_path):
    project = fixture(EpisodeProject.create("range", str(tmp_path)))
    apply(project, target(project), "mute")
    assert not project.clips[0].mute_regions
    assert not next(c for c in project.clips if c.id == "other").mute_regions
    assert [
        (r.start_s, r.end_s)
        for r in next(c for c in project.clips if c.id == "repeat").mute_regions
    ] == [(1, 2), (3, 4)]
    assert [
        (r.start_s, r.end_s) for r in next(c for c in project.clips if c.id == "moved").mute_regions
    ] == [(31, 32), (33, 34)]


@pytest.mark.parametrize("change", ["move", "gap_insert", "overlap", "mute"])
def test_stale_group_rejects_atomically_and_stays_pending(tmp_path, change):
    project = fixture(EpisodeProject.create("range", str(tmp_path)))
    selection = target(project, ((11, 16),))
    apply(project, selection, propose=True)
    if change == "move":
        project.clips[1].timeline_start += 1
    elif change == "gap_insert":
        project.clips.append(
            Clip(id="new", track_id="a", source_start=40, source_end=41, timeline_start=15)
        )
    elif change == "overlap":
        project.clips.append(
            Clip(id="new", track_id="b", source_start=40, source_end=41, timeline_start=11)
        )
    else:
        project.clips[1].fade_in_ms = 25
    before = deepcopy(project.clips)
    with pytest.raises(RangeChangedError, match="again"):
        approve_edits(project, ["range_action"])
    assert project.clips == before
    assert len(project.edit_decisions) == 1


@pytest.mark.parametrize("snap", [True, False])
def test_exact_proposal_rejects_legacy_timing(tmp_path, snap):
    project = fixture(EpisodeProject.create("range", str(tmp_path)))
    apply(project, target(project), propose=True)
    before = deepcopy(project.edit_decisions)
    with pytest.raises(ValueError, match="cannot change source timing"):
        update_pending_edit(project, "range_action", start=0, end=1, snap=snap)
    assert project.edit_decisions == before


def test_gap_cannot_mutate(tmp_path):
    project = fixture(EpisodeProject.create("range", str(tmp_path)))
    with pytest.raises(ValueError, match="No audible media"):
        apply(project, target(project, ((6, 8),)))


def command(selection, action="cut"):
    return DocumentCommand(
        type="EditSelectedRange",
        payload={"action": action, "target": selection.model_dump(mode="json")},
        client_id="test-range",
        client_seq=None,
        role="viewer",
    )


@pytest.mark.parametrize("caps", [None, ["suggest"], ["edit"], ["suggest", "edit"]])
def test_default_and_all_guests_propose(minimal_project, caps):
    ws = ProjectWorkspace.open(minimal_project)
    fixture(ws.project)
    save_project(ws.project)
    svc = DocumentSyncService.open(minimal_project)
    cmd = command(target(svc.ws.project))
    before = deepcopy(svc.ws.project.clips)
    result = svc.submit(cmd, capabilities=caps, range_policy="host_apply" if caps else "propose")
    assert result["ok"]
    assert svc.ws.project.clips == before
    assert len(svc.ws.project.edit_decisions) == 1
    if caps:
        with pytest.raises(PermissionError):
            svc.submit(
                DocumentCommand(
                    type="ApproveEdits",
                    payload={"ids": [cmd.command_id]},
                    client_id="guest",
                    client_seq=None,
                    role="guest",
                ),
                capabilities=caps,
            )
    approve = DocumentCommand(
        type="ApproveEdits",
        payload={"ids": [cmd.command_id]},
        client_id="host",
        client_seq=None,
        role="viewer",
    )
    svc.submit(approve, range_policy="host_apply")
    assert not svc.ws.project.edit_decisions
    assert spans(svc.ws.project, "b") == [(30, 31, 10), (32, 33, 12), (34, 35, 14)]
    HistoryService(svc.ws).undo()
    assert svc.ws.project.clips == before
    assert len(svc.ws.project.edit_decisions) == 1


def test_host_atomic_undo_and_idempotent_replay(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    fixture(ws.project)
    save_project(ws.project)
    svc = DocumentSyncService.open(minimal_project)
    before = deepcopy(svc.ws.project.clips)
    cmd = command(target(svc.ws.project))
    svc.submit(cmd, range_policy="host_apply")
    assert not svc.ws.project.edit_decisions
    assert svc.submit(cmd, range_policy="host_apply")["idempotent"] is True
    HistoryService(svc.ws).undo()
    assert svc.ws.project.clips == before


@pytest.mark.parametrize("field", ["apply", "scope", "authority", "_range_policy"])
def test_wire_cannot_elevate(minimal_project, field):
    project = fixture(load_project(minimal_project))
    payload = command(target(project)).payload | {field: "host_apply"}
    with pytest.raises(ValidationError):
        validate_payload("EditSelectedRange", payload)


def test_service_stale_conflict(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    fixture(ws.project)
    save_project(ws.project)
    selection = target(ws.project)
    ws.project.clips[1].timeline_start = 20
    save_project(ws.project)
    with pytest.raises(DocumentConflictError):
        DocumentSyncService.open(minimal_project).submit(
            command(selection), range_policy="host_apply"
        )


def test_full_lane_cut_reload_render_and_undo(minimal_project):
    import wave

    import numpy as np

    from podcast_mcp.edits.clips_ops import set_track_clips
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.engines.timeline_render import render_track_segment
    from podcast_mcp.models import MediaAsset
    from podcast_mcp.util.timebase import SourceSec

    ws = ProjectWorkspace.open(minimal_project)
    ws.project.tracks = [
        Track(id="a", label="a", media=MediaAsset(path="raw/host.wav", duration_sec=1))
    ]
    ws.project.clips = [
        Clip(id="full", track_id="a", source_start=0, source_end=1, timeline_start=0)
    ]
    ws.project.timeline.duration_sec = 1
    save_project(ws.project)
    svc = DocumentSyncService.open(minimal_project)
    svc.submit(command(target(svc.ws.project, ((0, 1),), ("a",))), range_policy="host_apply")
    project = load_project(minimal_project)
    assert project.tracks[0].timeline_empty is True
    assert project.clips == []
    assert SessionTimeline(project).source_to_timeline("a", SourceSec(0.5)) is None
    output = project.workspace_path() / "silent.wav"
    render_track_segment(project, "a", 0, 1, output, {})
    with wave.open(str(output), "rb") as audio:
        assert audio.getnframes() == 48000
        assert np.max(np.abs(np.frombuffer(audio.readframes(48000), dtype=np.int16))) == 0
    set_track_clips(
        project,
        "a",
        [Clip(id="added", track_id="a", source_start=0, source_end=1, timeline_start=0)],
    )
    assert project.tracks[0].timeline_empty is False
    HistoryService(svc.ws).undo()
    assert svc.ws.project.clips[0].id == "full"
    assert svc.ws.project.tracks[0].timeline_empty is False


def test_implicit_media_selection_is_read_only_until_apply(minimal_project):
    from podcast_mcp.models import MediaAsset

    ws = ProjectWorkspace.open(minimal_project)
    ws.project.tracks = [
        Track(id="a", label="a", media=MediaAsset(path="raw/host.wav", duration_sec=5))
    ]
    selection = target(ws.project, ((1, 2),), ("a",))
    assert not ws.project.clips
    apply(ws.project, selection)
    assert spans(ws.project, "a") == [(0, 1, 0), (2, 5, 2)]


def test_media_change_invalidates_proposal(tmp_path):
    from podcast_mcp.models import MediaAsset

    project = fixture(EpisodeProject.create("range", str(tmp_path)))
    selection = target(project)
    project.tracks[0].media = MediaAsset(path="different.wav")
    with pytest.raises(RangeChangedError):
        apply(project, selection)


def test_supported_agent_cannot_approve_exact_proposal(minimal_project):
    from podcast_mcp.mcp.tools.agent_document import submit_host_document_command
    from podcast_mcp.mcp.tools.edits import approve_edits_tool

    ws = ProjectWorkspace.open(minimal_project)
    fixture(ws.project)
    save_project(ws.project)
    result = submit_host_document_command(
        str(minimal_project), "EditSelectedRange", command(target(ws.project)).payload
    )
    proposal = load_project(minimal_project).edit_decisions[0]
    assert result["ok"]
    with pytest.raises(PermissionError):
        submit_host_document_command(str(minimal_project), "ApproveEdits", {"ids": [proposal.id]})
    with pytest.raises(PermissionError):
        approve_edits_tool(str(minimal_project), '["' + proposal.id + '"]')
    assert len(load_project(minimal_project).edit_decisions) == 1


def test_saved_receipt_replay_has_no_result_or_second_history(minimal_project):
    import sqlite3
    from unittest.mock import patch

    from sqlite_helpers import FailingConnection

    ws = ProjectWorkspace.open(minimal_project)
    fixture(ws.project)
    save_project(ws.project)
    svc = DocumentSyncService.open(minimal_project)
    cmd = command(target(svc.ws.project))
    before = deepcopy(svc.ws.project.clips)
    with patch.object(
        svc.store, "_conn", FailingConnection(svc.store._conn, "INSERT INTO commands")
    ):
        with pytest.raises(sqlite3.OperationalError):
            svc.submit(cmd, range_policy="host_apply")
    retry = DocumentSyncService.open(minimal_project)
    result = retry.submit(cmd, range_policy="host_apply")
    assert result["idempotent"] is True
    assert result["command"]["payload"]["result"] is None
    assert retry.ws.project.editorial.edit_log[-1].params["action_id"] == cmd.command_id
    HistoryService(retry.ws).undo()
    assert retry.ws.project.clips == before


def test_direct_mcp_cannot_reject_exact_proposal_but_human_cli_can(minimal_project):
    import json

    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app
    from podcast_mcp.mcp import server

    ws = ProjectWorkspace.open(minimal_project)
    fixture(ws.project)
    apply(ws.project, target(ws.project), propose=True)
    save_project(ws.project)
    before = deepcopy(ws.project.clips)
    with pytest.raises(PermissionError, match="interactive host"):
        server.reject_edits_tool(str(minimal_project), json.dumps(["range_action"]))
    assert len(load_project(minimal_project).edit_decisions) == 1
    result = CliRunner().invoke(
        app, ["edit", "reject", "--project", str(minimal_project), "--ids", "range_action"]
    )
    assert result.exit_code == 0, result.output
    assert "Removed 1 edit(s)" in result.output
    restored = load_project(minimal_project)
    assert restored.edit_decisions == []
    assert restored.clips == before


@pytest.mark.parametrize("ids", [None, "action", [{}], [["action"]], [1]])
@pytest.mark.parametrize("action", ["ApproveEdits", "RejectEdits"])
def test_decision_policy_validates_ids_before_membership(minimal_project, ids, action):
    svc = DocumentSyncService.open(minimal_project)
    fixture(svc.ws.project)
    apply(svc.ws.project, target(svc.ws.project), propose=True)
    save_project(svc.ws.project)
    with pytest.raises(ValueError):
        svc.submit(
            DocumentCommand(
                type=action, payload={"ids": ids}, client_id="agent", role="agent", client_seq=None
            )
        )
    assert len(load_project(minimal_project).edit_decisions) == 1
