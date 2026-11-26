"""One Restore operation on every surface: web document command, MCP tool and CLI (#3114)."""

from __future__ import annotations

import json
import re
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from podcast_mcp.cli.edit import edit_app
from podcast_mcp.edits.edit_log import archive_timeline_op
from podcast_mcp.edits.off_speaker_mute import OffSpeakerPlan
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.engines.mute_regions import add_source_mute
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import (
    Clip,
    ClipMuteRegion,
    EditDecisionType,
    SourceRecording,
    Track,
    TrackRole,
    UnmuteSource,
    load_project,
    save_project,
)
from podcast_mcp.project.store import history_index_path, history_snapshot_ids
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document import EditService, HistoryService, TimelineService
from podcast_mcp.services.document.analysis import AnalysisService
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.services.remote_mcp.allowlist import tools_for_capabilities
from source_review_helpers import _cut, _project

pytestmark = pytest.mark.refine_gate

SURFACES = ["web", "mcp", "cli"]


def _mute_workspace(root, name="p"):
    project = _project(root / name)
    mute = _cut("mute", 1, 2, reason="filler:um")
    mute.type = EditDecisionType.MUTE
    project.edit_decisions = [mute]
    REFINE_GATE.mark_done(project, notes="Known synthetic fixture; no real-project acceptance")
    ws = ProjectWorkspace.open(save_project(project))
    assert EditService(ws).approve(["mute"]) == 1
    return ws


def _ripple_workspace(root, name="ripple"):
    project = _project(root / name)
    project.edit_decisions = [_cut("cut", reason="filler:um")]
    REFINE_GATE.mark_done(project, notes="Known synthetic fixture; no real-project acceptance")
    ws = ProjectWorkspace.open(save_project(project))
    assert EditService(ws).approve(["cut"]) == 1
    return ws


def _trim_workspace(root):
    """A record no inverse can undo: a trim is History-only."""
    ws = _ripple_workspace(root)
    ws.mutate(
        "before trim",
        "after trim",
        lambda p: (
            setattr(p.editorial, "edit_log", [])
            or archive_timeline_op(p, operation="trim_clip_edge", track_ids=["host"])
        ),
    )
    return ws


def _restore(surface, ws, ids, *, dry_run=False, cli_exit=0):
    """RestoreResult JSON from one surface."""
    if surface == "web":
        with TestClient(create_app()) as client:
            reply = client.post(
                f"/api/document/command?path={quote(str(ws.path))}",
                json={
                    "type": "RestoreAppliedEdit",
                    "payload": {"ids": ids, "dry_run": dry_run},
                    "client_id": "parity",
                    "client_seq": 1,
                },
            )
        assert reply.status_code == 200, reply.text
        return reply.json()["command"]["payload"]["result"]
    if surface == "mcp":
        return json.loads(mcp_server.revert_applied_edit_tool(str(ws.path), ids, dry_run))
    args = ["restore-edit", "--project", str(ws.path), "--json"]
    for record_id in ids:
        args += ["--id", record_id]
    if dry_run:
        args.append("--dry-run")
    result = CliRunner().invoke(edit_app, args)
    assert result.exit_code == cli_exit, result.output
    return json.loads(result.stdout)


def _post_state(ws):
    project = load_project(ws.path)
    return json.dumps(
        {
            "clips": [c.model_dump(mode="json") for c in project.clips],
            "editorial": project.editorial.model_dump(mode="json"),
            "transcripts": project.transcript_data.model_dump(mode="json"),
            "duration": project.timeline.duration_sec,
        },
        sort_keys=True,
    )


def _disk_and_history(ws):
    index = history_index_path(ws.project)
    return ws.path.read_bytes(), index.read_bytes(), history_snapshot_ids(index)


def test_one_mute_record_restores_identically_on_web_mcp_and_cli(tmp_path):
    outcomes = {}
    for surface in SURFACES:
        ws = _mute_workspace(tmp_path, surface)
        record = ws.project.editorial.edit_log[0]
        assert record.inverse is not None and record.inverse.kind == "unmute"
        result = _restore(surface, ws, [record.id])
        outcomes[surface] = (
            json.dumps(result, sort_keys=True).replace(record.id, "REC"),
            _post_state(ws).replace(record.id, "REC"),
        )
    assert json.loads(outcomes["web"][0])["status"] == "restored"
    assert json.loads(outcomes["web"][1])["editorial"]["edit_log"] == []
    assert outcomes["mcp"] == outcomes["web"]
    assert outcomes["cli"] == outcomes["web"]


@pytest.mark.parametrize("surface", SURFACES)
def test_dry_run_writes_nothing_and_adds_no_history_step(tmp_path, surface):
    ws = _mute_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    head = HistoryService(ws).status().head_id
    before = (_disk_and_history(ws), _post_state(ws))
    result = _restore(surface, ws, [record_id], dry_run=True)
    assert result["status"] == "planned"
    assert result["summary"]["ids"] == [record_id]
    assert (_disk_and_history(ws), _post_state(ws)) == before
    assert HistoryService(ws).status().head_id == head


def test_several_ids_restore_in_one_history_step(tmp_path):
    project = _project(tmp_path)
    first, second = _cut("m1", 1, 2, reason="filler:um"), _cut("m2", 3, 4, reason="filler:um")
    for mute in (first, second):
        mute.type = EditDecisionType.MUTE
    project.edit_decisions = [first, second]
    REFINE_GATE.mark_done(project, notes="Known synthetic fixture; no real-project acceptance")
    ws = ProjectWorkspace.open(save_project(project))
    assert EditService(ws).approve(["m1", "m2"]) == 2
    ids = [r.id for r in ws.project.editorial.edit_log]
    assert len(ids) == 2
    steps = len(history_snapshot_ids(history_index_path(ws.project)))
    result = EditService(ws).revert_applied(ids)
    assert result["status"] == "restored"
    assert result["summary"]["ids"] == ids
    assert len(history_snapshot_ids(history_index_path(ws.project))) == steps + 1
    assert load_project(ws.path).editorial.edit_log == []
    assert all(c.mute_regions == [] for c in load_project(ws.path).clips)


def test_unknown_id_is_a_conflict_that_writes_nothing(tmp_path):
    ws = _mute_workspace(tmp_path)
    before = (_disk_and_history(ws), _post_state(ws))
    result = EditService(ws).revert_applied(["alog_missing", ws.project.editorial.edit_log[0].id])
    assert result["status"] == "conflict"
    assert [(c["code"], c["record_id"]) for c in result["conflicts"]] == [
        ("applied_edit_not_found", "alog_missing")
    ]
    assert (_disk_and_history(ws), _post_state(ws)) == before


def test_cli_exits_2_on_conflict(tmp_path):
    ws = _mute_workspace(tmp_path)
    result = CliRunner().invoke(
        edit_app, ["restore-edit", "--project", str(ws.path), "--id", "alog_missing", "--json"]
    )
    assert result.exit_code == 2
    assert json.loads(result.stdout)["conflicts"][0]["code"] == "applied_edit_not_found"


def test_mute_and_ripple_report_ready_and_a_trim_reports_history_only(tmp_path):
    mute = EditService(_mute_workspace(tmp_path)).list_applied_edits()["records"][0]
    ripple = EditService(_ripple_workspace(tmp_path)).list_applied_edits()["records"][0]
    trim_ws = _trim_workspace(tmp_path)
    trim = EditService(trim_ws).list_applied_edits()["records"][0]
    ready = {"state": "ready", "code": None, "message": None, "blocked_by": []}
    assert mute["restore"] == ready
    assert ripple["restore"] == ready
    # The listing carries the restore state; the inverse (clips, comment bodies) stays stored.
    assert "inverse" not in mute and "inverse" not in ripple and "inverse" not in trim
    assert trim["restore"]["state"] == "history_only"
    listed = CliRunner().invoke(edit_app, ["applied", "--project", str(trim_ws.path), "--json"])
    assert listed.exit_code == 0
    assert json.loads(listed.stdout)["records"][0]["restore"]["state"] == "history_only"


def test_cli_exits_2_for_a_history_only_record(tmp_path):
    ws = _trim_workspace(tmp_path)
    result = CliRunner().invoke(
        edit_app,
        ["restore-edit", "--project", str(ws.path), "--id", ws.project.editorial.edit_log[0].id],
    )
    assert result.exit_code == 2
    assert "History Undo" in result.output


def test_one_ripple_record_restores_identically_on_web_mcp_and_cli(tmp_path):
    outcomes = {}
    for surface in SURFACES:
        ws = _ripple_workspace(tmp_path, surface)
        record = ws.project.editorial.edit_log[0]
        assert record.inverse is not None and record.inverse.kind == "reinsert_clips"
        result = _restore(surface, ws, [record.id])
        outcomes[surface] = (
            json.dumps(result, sort_keys=True).replace(record.id, "REC"),
            re.sub(r"clip_[0-9a-f]{8}", "CLIP", _post_state(ws).replace(record.id, "REC")),
        )
    web = json.loads(outcomes["web"][1])
    assert json.loads(outcomes["web"][0])["status"] == "restored"
    assert web["editorial"]["edit_log"] == []
    assert web["duration"] == 6
    assert [(c["source_start"], c["source_end"], c["timeline_start"]) for c in web["clips"]] == [
        (0, 1, 0),
        (1, 2, 1),
        (2, 6, 2),
    ]
    assert outcomes["mcp"] == outcomes["web"]
    assert outcomes["cli"] == outcomes["web"]


@pytest.mark.parametrize("surface", SURFACES)
def test_dry_run_of_a_ripple_record_writes_nothing(tmp_path, surface):
    ws = _ripple_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    head = HistoryService(ws).status().head_id
    before = (_disk_and_history(ws), _post_state(ws))
    result = _restore(surface, ws, [record_id], dry_run=True)
    assert result["status"] == "planned"
    assert result["summary"]["ids"] == [record_id]
    assert (_disk_and_history(ws), _post_state(ws)) == before
    assert HistoryService(ws).status().head_id == head


def test_viewer_is_denied_on_web_mcp_and_cli(tmp_path, monkeypatch):
    ws = _mute_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    viewer = capabilities_for_role("viewer")
    before = (_disk_and_history(ws), _post_state(ws))

    command = DocumentCommand(
        type="RestoreAppliedEdit",
        payload={"ids": [record_id], "dry_run": False},
        client_id="guest",
        client_seq=None,
        role="guest",
    )
    with pytest.raises(PermissionError, match="RestoreAppliedEdit"):
        DocumentSyncService.open(ws.path).submit(command, capabilities=viewer)
    assert "guest_submit_document_command" not in tools_for_capabilities(viewer)

    def forbidden(*_args, **_kwargs):
        raise PermissionError("share capabilities do not allow document command")

    monkeypatch.setattr(
        "podcast_mcp.services.document_sync.submit_host_document_command", forbidden
    )
    result = CliRunner().invoke(
        edit_app, ["restore-edit", "--project", str(ws.path), "--id", record_id]
    )
    assert result.exit_code == 3
    assert (_disk_and_history(ws), _post_state(ws)) == before


def _journal_rows(ws):
    return DocumentSyncService.open(ws.path).store.commands_after(0)


def _regions(ws):
    return [
        [(round(r.start_s, 3), round(r.end_s, 3), r.gain_db) for r in c.mute_regions]
        for c in load_project(ws.path).clips
    ]


def _two_overlapping_mutes(root):
    project = _project(root)
    first, second = _cut("m1", 1, 2, reason="filler:um"), _cut("m2", 1.9, 3, reason="filler:um")
    for mute in (first, second):
        mute.type = EditDecisionType.MUTE
    project.edit_decisions = [first, second]
    REFINE_GATE.mark_done(project, notes="Known synthetic fixture; no real-project acceptance")
    ws = ProjectWorkspace.open(save_project(project))
    assert EditService(ws).approve(["m1"]) == 1
    assert EditService(ws).approve(["m2"]) == 1
    return ws


@pytest.mark.parametrize("surface", SURFACES)
def test_dry_run_adds_no_journal_row(tmp_path, surface):
    ws = _mute_workspace(tmp_path)
    rows = len(_journal_rows(ws))
    result = _restore(surface, ws, [ws.project.editorial.edit_log[0].id], dry_run=True)
    assert result["status"] == "planned"
    assert len(_journal_rows(ws)) == rows


def test_restoring_the_earlier_of_two_overlapping_mutes_is_a_typed_conflict(tmp_path):
    ws = _two_overlapping_mutes(tmp_path)
    first, second = (r.id for r in ws.project.editorial.edit_log)
    before = (_disk_and_history(ws), _regions(ws))
    result = EditService(ws).revert_applied([first])
    assert result["status"] == "conflict"
    assert [(c["code"], c["record_id"], c["blocked_by"]) for c in result["conflicts"]] == [
        ("overlapped_by_later", first, [second])
    ]
    listed = {r["id"]: r["restore"] for r in EditService(ws).list_applied_edits()["records"]}
    assert listed[first]["state"] == "blocked"
    assert listed[first]["code"] == "overlapped_by_later"
    assert listed[second]["state"] == "ready"
    assert (_disk_and_history(ws), _regions(ws)) == before


def test_restoring_the_later_mute_keeps_the_earlier_mutes_audio_silent(tmp_path):
    ws = _two_overlapping_mutes(tmp_path)
    first, second = (r.id for r in ws.project.editorial.edit_log)
    assert EditService(ws).revert_applied([second])["status"] == "restored"
    regions = load_project(ws.path).clips[0].mute_regions
    assert [(r.start_s, r.end_s) for r in regions] == [(pytest.approx(0.995), pytest.approx(2.015))]
    assert [r.id for r in load_project(ws.path).editorial.edit_log] == [first]


def test_restoring_both_overlapping_mutes_together_clears_them(tmp_path):
    ws = _two_overlapping_mutes(tmp_path)
    ids = [r.id for r in ws.project.editorial.edit_log]
    assert EditService(ws).revert_applied(ids)["status"] == "restored"
    assert _regions(ws) == [[]]


def test_a_lower_record_records_only_what_it_wrote_and_never_reopens_a_hard_mute(tmp_path):
    from podcast_mcp.edits.cut_application import apply_lower
    from podcast_mcp.edits.edit_log import apply_restores, plan_restores

    ws = _mute_workspace(tmp_path)
    project = ws.project.model_copy(deep=True)
    hard = [(r.start_s, r.end_s) for c in project.clips for r in c.mute_regions]
    lower = _cut("lo", 1.5, 4, reason="sound:laugh")
    assert apply_lower(project, lower, defaults=ws.effective_config())
    record = project.editorial.edit_log[-1]
    lo_spans = [(s.start, s.end) for s in record.inverse.spans]
    assert lo_spans == [(pytest.approx(hard[0][1]), pytest.approx(4.0))]

    plans, conflicts = plan_restores(project, [record.id], defaults=ws.effective_config())
    assert conflicts == []
    apply_restores(project, plans, defaults=ws.effective_config())
    assert [(r.start_s, r.end_s) for c in project.clips for r in c.mute_regions] == hard


def test_restore_after_the_muted_clip_is_gone_is_a_conflict_not_an_empty_step(tmp_path):
    ws = _mute_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    ws.mutate("before drop", "after drop", lambda p: setattr(p, "clips", []))
    before = _disk_and_history(ws)
    listed = EditService(ws).list_applied_edits()["records"][0]["restore"]
    assert listed["state"] == "blocked"
    assert listed["code"] == "span_not_present"
    result = EditService(ws).revert_applied([record_id])
    assert result["status"] == "conflict"
    assert [c["code"] for c in result["conflicts"]] == ["span_not_present"]
    assert _disk_and_history(ws) == before


@pytest.mark.parametrize("dry_run", [False, True])
@pytest.mark.parametrize("surface", SURFACES)
def test_history_only_record_is_conflict_data_on_every_surface(tmp_path, surface, dry_run):
    ws = _trim_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    rows = len(_journal_rows(ws))
    before = (_disk_and_history(ws), _post_state(ws))
    result = _restore(surface, ws, [record_id, "alog_missing"], dry_run=dry_run, cli_exit=2)
    assert result["status"] == "conflict"
    assert sorted((c["code"], c["record_id"]) for c in result["conflicts"]) == [
        ("applied_edit_not_found", "alog_missing"),
        ("local_restore_requires_history", record_id),
    ]
    assert (_disk_and_history(ws), _post_state(ws)) == before
    if dry_run:
        assert len(_journal_rows(ws)) == rows


def _guest_submit(ws, ids, *, dry_run):
    command = DocumentCommand(
        type="RestoreAppliedEdit",
        payload={"ids": ids, "dry_run": dry_run},
        client_id="guest",
        client_seq=None,
        role="guest",
    )
    return DocumentSyncService.open(ws.path).submit(
        command, capabilities=capabilities_for_role("editor"), audience="guest"
    )


@pytest.mark.parametrize("dry_run", [False, True])
def test_guest_reply_hides_command_payload_and_still_reports_the_conflict(tmp_path, dry_run):
    ws = _trim_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    reply = _guest_submit(ws, [record_id], dry_run=dry_run)
    assert reply["command"] == {"type": "RestoreAppliedEdit"}
    assert [c["code"] for c in reply["restore_conflicts"]] == ["local_restore_requires_history"]


@pytest.mark.parametrize("dry_run", [False, True])
def test_guest_reply_tells_a_history_only_cut_in_guest_words(tmp_path, dry_run):
    ws = _trim_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    reply = _guest_submit(ws, [record_id], dry_run=dry_run)
    assert reply["restore_conflicts"] == [
        {
            "code": "local_restore_requires_history",
            "record_id": record_id,
            "track_id": None,
            "blocked_by": [],
            "message": (
                "This cut can't be put back on its own. Undo takes back your own latest "
                "change; for anything else, ask the host."
            ),
        }
    ]


def test_host_reply_keeps_the_history_message_for_a_history_only_cut(tmp_path):
    ws = _trim_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    command = DocumentCommand(
        type="RestoreAppliedEdit",
        payload={"ids": [record_id]},
        client_id="host",
        client_seq=None,
        role="host",
    )
    reply = DocumentSyncService.open(ws.path).submit(command)
    assert reply["restore_conflicts"][0]["message"] == (
        "This edit cannot be restored individually. Use History Undo to restore the whole "
        "action. History Undo also undoes the other edits in that action. You may need to "
        "undo later actions first."
    )


def test_guest_dry_run_plan_reply_hides_command_payload(tmp_path):
    ws = _mute_workspace(tmp_path)
    reply = _guest_submit(ws, [ws.project.editorial.edit_log[0].id], dry_run=True)
    assert reply["command"] == {"type": "RestoreAppliedEdit"}
    assert "restore_conflicts" not in reply


@pytest.mark.parametrize("surface", SURFACES)
def test_conflict_leaves_no_journal_row_and_no_server_seq(tmp_path, surface):
    ws = _trim_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    rows = len(_journal_rows(ws))
    before = (_disk_and_history(ws), _post_state(ws))
    result = _restore(surface, ws, [record_id], cli_exit=2)
    assert result["status"] == "conflict"
    assert len(_journal_rows(ws)) == rows
    assert (_disk_and_history(ws), _post_state(ws)) == before


def _web_restore(ws, ids, *, command_id, dry_run=False, client_seq=None):
    with TestClient(create_app()) as client:
        reply = client.post(
            f"/api/document/command?path={quote(str(ws.path))}",
            json={
                "type": "RestoreAppliedEdit",
                "payload": {"ids": ids, "dry_run": dry_run},
                "client_id": "retry",
                "client_seq": client_seq,
                "command_id": command_id,
            },
        )
    assert reply.status_code == 200, reply.text
    return reply.json()


def _cli_restore(ws, ids, *, command_id, dry_run=False):
    args = ["restore-edit", "--project", str(ws.path), "--json", "--command-id", command_id]
    for record_id in ids:
        args += ["--id", record_id]
    if dry_run:
        args.append("--dry-run")
    result = CliRunner().invoke(edit_app, args)
    assert result.exit_code == 0, result.output
    return json.loads(result.stdout)


def test_retrying_a_succeeded_restore_on_the_web_returns_the_stored_result(tmp_path):
    ws = _mute_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    first = _web_restore(ws, [record_id], command_id="web-retry")
    assert first["command"]["payload"]["result"]["status"] == "restored"
    rows, after = len(_journal_rows(ws)), _post_state(ws)
    retry = _web_restore(ws, [record_id], command_id="web-retry")
    assert retry["idempotent"] is True
    assert retry["command"]["payload"]["result"] == first["command"]["payload"]["result"]
    assert "restore_conflicts" not in retry
    assert (len(_journal_rows(ws)), _post_state(ws)) == (rows, after)


def test_retrying_a_succeeded_restore_from_the_cli_returns_the_stored_result(tmp_path):
    ws = _mute_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    first = _cli_restore(ws, [record_id], command_id="cli-retry")
    assert first["status"] == "restored"
    rows, after = len(_journal_rows(ws)), _post_state(ws)
    assert _cli_restore(ws, [record_id], command_id="cli-retry") == first
    assert (len(_journal_rows(ws)), _post_state(ws)) == (rows, after)


def test_dry_run_with_a_reused_command_id_plans_afresh_and_writes_nothing(tmp_path):
    ws = _mute_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    rows = len(_journal_rows(ws))
    for _ in range(2):
        reply = _web_restore(ws, [record_id], command_id="dry-reuse", dry_run=True)
        assert reply["dry_run"] is True
        assert reply["command"]["payload"]["result"]["status"] == "planned"
    assert len(_journal_rows(ws)) == rows
    applied = _web_restore(ws, [record_id], command_id="dry-reuse")
    assert applied["command"]["payload"]["result"]["status"] == "restored"
    assert len(_journal_rows(ws)) == rows + 1


def test_retrying_a_succeeded_ripple_restore_returns_the_stored_result(tmp_path):
    for surface, restore in (("web", _web_restore), ("cli", _cli_restore)):
        ws = _ripple_workspace(tmp_path, surface)
        record_id = ws.project.editorial.edit_log[0].id
        first = restore(ws, [record_id], command_id=f"{surface}-ripple-retry")
        rows, after = len(_journal_rows(ws)), _post_state(ws)
        retry = restore(ws, [record_id], command_id=f"{surface}-ripple-retry")
        if surface == "web":
            assert first["command"]["payload"]["result"]["status"] == "restored"
            assert retry["idempotent"] is True
            assert retry["command"]["payload"]["result"] == first["command"]["payload"]["result"]
        else:
            assert first["status"] == "restored"
            assert retry == first
        assert (len(_journal_rows(ws)), _post_state(ws)) == (rows, after)


# Exact-range and off-speaker mutes restore on their own (#3114).
def _workspace(root, *, clips=None, tracks=(), sources=()):
    project = _project(root)
    project.tracks.extend(tracks)
    project.sources.extend(sources)
    if clips is not None:
        project.clips = clips
    REFINE_GATE.mark_done(project, notes="Known synthetic fixture; no real-project acceptance")
    return ProjectWorkspace.open(save_project(project))


def _mute(ws, start, end, *, action_id, tracks=("host",)):
    svc = EditService(ws)
    return svc.edit_selected_range(
        [svc.selected_range_target(start, end, list(tracks))],
        "mute",
        propose=False,
        reason="host:range",
        action_id=action_id,
    )


def _off_speaker(ws, monkeypatch, *regions):
    plan = OffSpeakerPlan(
        track_id="host",
        regions=[
            {"start": a, "end": b, "duration": b - a, "audible_sec": b - a} for a, b in regions
        ],
    )
    monkeypatch.setattr(
        "podcast_mcp.edits.off_speaker_mute.plan_off_speaker_mutes", lambda *_a, **_k: plan
    )
    return AnalysisService(ws).mute_off_speaker(track_id="host")


def _digest(ws):
    return json.dumps(
        [
            {
                "id": c.id,
                "mute_regions": [r.model_dump(mode="json") for r in c.mute_regions],
                "off_speaker_mute_regions": [
                    r.model_dump(mode="json") for r in c.off_speaker_mute_regions
                ],
                "fade_in_ms": c.fade_in_ms,
                "fade_out_ms": c.fade_out_ms,
            }
            for c in sorted(load_project(ws.path).clips, key=lambda c: (c.track_id, c.id))
        ],
        sort_keys=True,
    )


def _states(ws):
    return [r["restore"]["state"] for r in EditService(ws).list_applied_edits()["records"]]


def _ids(ws):
    return [r.id for r in ws.project.editorial.edit_log]


def _hard_mute(ws, start, end):
    def write(p):
        add_source_mute(p.clips[0], ClipMuteRegion(start_s=start, end_s=end))

    ws.mutate("before", "after", write)


def test_ordinary_range_mute_restores_alone(tmp_path):
    ws = _workspace(tmp_path)
    before = _digest(ws)
    _mute(ws, 1, 2, action_id="m")
    assert _digest(ws) != before
    assert _states(ws) == ["ready"]
    assert EditService(ws).revert_applied(_ids(ws))["status"] == "restored"
    assert _digest(ws) == before
    assert ws.project.editorial.edit_log == []


def test_off_speaker_mute_restores_alone(tmp_path, monkeypatch):
    ws = _workspace(tmp_path)
    before = _digest(ws)
    assert _off_speaker(ws, monkeypatch, (1, 2))["applied_count"] == 1
    assert ws.project.clips[0].off_speaker_mute_regions
    assert _states(ws) == ["ready"]
    assert EditService(ws).revert_applied(_ids(ws))["status"] == "restored"
    assert _digest(ws) == before


def test_batch_of_off_speaker_edits_restores_each_and_all(tmp_path, monkeypatch):
    ws = _workspace(tmp_path)
    before = _digest(ws)
    assert _off_speaker(ws, monkeypatch, (0.5, 1), (2, 3), (4, 5))["applied_count"] == 3
    ids = _ids(ws)
    assert _states(ws) == ["ready"] * 3
    assert EditService(ws).revert_applied(ids[1:2])["status"] == "restored"
    spans = [(r.start_s, r.end_s) for r in load_project(ws.path).clips[0].off_speaker_mute_regions]
    assert spans == [(0.5, 1), (4, 5)]
    assert EditService(ws).revert_applied(_ids(ws))["status"] == "restored"
    assert _digest(ws) == before


def test_later_overlapping_mute_with_an_inverse_blocks_the_earlier(tmp_path):
    ws = _workspace(tmp_path)
    earlier_before = _digest(ws)
    _mute(ws, 1, 2, action_id="first")
    later = _cut("later", 1.5, 3, reason="filler:um")
    later.type = EditDecisionType.MUTE

    def propose(p):
        p.edit_decisions = [later]

    ws.mutate("before", "after", propose)
    assert EditService(ws).approve(["later"]) == 1
    first, second = _ids(ws)
    result = EditService(ws).revert_applied([first])
    assert result["status"] == "conflict"
    assert [(c["code"], c["blocked_by"]) for c in result["conflicts"]] == [
        ("overlapped_by_later", [second])
    ]
    assert EditService(ws).revert_applied([first, second])["status"] == "restored"
    assert _digest(ws) == earlier_before


def test_ordinary_and_off_speaker_over_the_same_span_restore_independently(tmp_path, monkeypatch):
    ws = _workspace(tmp_path)
    _mute(ws, 1, 2, action_id="ordinary")
    _off_speaker(ws, monkeypatch, (1, 2))
    ordinary, automatic = _ids(ws)
    assert _states(ws) == ["ready", "ready"]
    assert EditService(ws).revert_applied([ordinary])["status"] == "restored"
    clip = load_project(ws.path).clips[0]
    assert clip.mute_regions == []
    assert [(r.start_s, r.end_s) for r in clip.off_speaker_mute_regions] == [(1, 2)]
    assert EditService(ws).revert_applied([automatic])["status"] == "restored"
    assert load_project(ws.path).clips[0].off_speaker_mute_regions == []


def test_ordinary_restore_leaves_an_off_speaker_mute_it_did_not_write(tmp_path, monkeypatch):
    ws = _workspace(tmp_path)
    _off_speaker(ws, monkeypatch, (1, 2))
    _mute(ws, 1, 2, action_id="ordinary")
    automatic, ordinary = _ids(ws)
    assert EditService(ws).revert_applied([automatic])["status"] == "restored"
    clip = load_project(ws.path).clips[0]
    assert [(r.start_s, r.end_s) for r in clip.mute_regions] == [(1, 2)]
    assert clip.off_speaker_mute_regions == []
    assert _states(ws) == ["ready"]
    assert _ids(ws) == [ordinary]


@pytest.mark.parametrize("existing", [(0.5, 1.5), (1.5, 2.5), (0.5, 1), (2, 3), (0.2, 3.5)])
def test_a_mute_over_or_abutting_an_existing_region_is_history_only(tmp_path, existing):
    ws = _workspace(tmp_path)
    _hard_mute(ws, *existing)
    _mute(ws, 1, 2, action_id="m")
    record = EditService(ws).list_applied_edits()["records"][-1]
    assert record["restore"]["state"] == "history_only"
    assert record["restore"]["code"] == "local_restore_requires_history"


def test_an_off_speaker_mute_over_an_existing_region_is_history_only(tmp_path, monkeypatch):
    ws = _workspace(tmp_path)
    _off_speaker(ws, monkeypatch, (1, 2))
    _off_speaker(ws, monkeypatch, (1.5, 2.5))
    assert _states(ws) == ["blocked", "history_only"]


def test_a_range_over_two_tracks_restores_every_track_with_one_record(tmp_path):
    base = _project(tmp_path / "seed")
    guest = Track(id="guest", label="Guest", role=TrackRole.DIALOGUE, media=base.tracks[0].media)
    clips = [
        base.clips[0],
        Clip(id="guest", track_id="guest", source_start=0, source_end=6, timeline_start=0),
    ]
    ws = _workspace(tmp_path / "ws", clips=clips, tracks=[guest])
    before = _digest(ws)
    _mute(ws, 1, 2, action_id="both", tracks=("host", "guest"))
    assert len(_ids(ws)) == 1
    assert all(c.mute_regions for c in ws.project.clips)
    assert EditService(ws).revert_applied(_ids(ws))["status"] == "restored"
    assert _digest(ws) == before


def test_split_after_the_mute_restores_both_halves(tmp_path):
    ws = _workspace(tmp_path)
    _mute(ws, 1, 3, action_id="m")
    TimelineService(ws).split_clip(2, track_id="host")
    assert len(load_project(ws.path).clips) == 2
    assert all(c.mute_regions for c in load_project(ws.path).clips)
    assert _states(ws)[0] == "ready"
    assert EditService(ws).revert_applied(_ids(ws)[:1])["status"] == "restored"
    assert not any(c.mute_regions for c in load_project(ws.path).clips)
    assert not any(c.off_speaker_mute_regions for c in load_project(ws.path).clips)


def test_a_clip_of_another_source_with_the_same_numbers_is_untouched(tmp_path):
    clips = [
        Clip(
            id="a", track_id="host", source_id="a", source_start=0, source_end=3, timeline_start=0
        ),
        Clip(
            id="b", track_id="host", source_id="b", source_start=0, source_end=3, timeline_start=3
        ),
    ]
    sources = [
        SourceRecording(id=name, path="raw/host.wav", speaker="Host", duration_sec=6)
        for name in ("a", "b")
    ]
    ws = _workspace(tmp_path / "ws", clips=clips, sources=sources)

    def other(p):
        add_source_mute(p.clips[1], ClipMuteRegion(start_s=1, end_s=2))

    ws.mutate("before", "after", other)
    _mute(ws, 1, 2, action_id="m")
    assert _states(ws) == ["ready"]
    assert EditService(ws).revert_applied(_ids(ws))["status"] == "restored"
    by_id = {c.id: c for c in load_project(ws.path).clips}
    assert by_id["a"].mute_regions == []
    assert [(r.start_s, r.end_s) for r in by_id["b"].mute_regions] == [(1, 2)]


def test_a_record_without_ownership_loads_and_restores_as_an_ordinary_mute(tmp_path):
    ws = _workspace(tmp_path)

    def write(p):
        add_source_mute(p.clips[0], ClipMuteRegion(start_s=1, end_s=2))
        legacy = UnmuteSource.model_validate(
            {"kind": "unmute", "spans": [{"track_id": "host", "start": 1, "end": 2}]}
        )
        archive_timeline_op(p, operation="edit_selected_range", track_ids=["host"], inverse=legacy)

    ws.mutate("before", "after", write)
    assert "mute_ownership" not in load_project(ws.path).editorial.edit_log[0].params
    assert _states(ws) == ["ready"]
    assert EditService(ws).revert_applied(_ids(ws))["status"] == "restored"
    assert load_project(ws.path).clips[0].mute_regions == []


def test_only_an_off_speaker_record_carries_the_ownership_param(tmp_path, monkeypatch):
    ws = _workspace(tmp_path)
    _mute(ws, 1, 2, action_id="ordinary")
    _off_speaker(ws, monkeypatch, (3, 4))
    ordinary, automatic = ws.project.editorial.edit_log
    assert "mute_ownership" not in ordinary.params
    assert automatic.params["mute_ownership"] == "off_speaker"


def test_exact_off_speaker_restore_does_not_carve_an_overlapping_neighbour(tmp_path, monkeypatch):
    ws = _workspace(tmp_path)
    _off_speaker(ws, monkeypatch, (1, 2))
    first = _ids(ws)[0]
    # An off-speaker region no record owns, overlapping the recorded one.

    def neighbour(p):
        from podcast_mcp.engines.off_speaker_regions import add_off_speaker_mute
        from podcast_mcp.models import ClipOffSpeakerMuteRegion

        add_off_speaker_mute(p.clips[0], ClipOffSpeakerMuteRegion(start_s=1.5, end_s=2.5))

    ws.mutate("before", "after", neighbour)
    assert EditService(ws).revert_applied([first])["status"] == "restored"
    spans = [(r.start_s, r.end_s) for r in load_project(ws.path).clips[0].off_speaker_mute_regions]
    assert spans == [(1.5, 2.5)]


def test_a_mute_that_wrote_nothing_new_has_no_inverse(tmp_path, monkeypatch):
    ws = _workspace(tmp_path)
    _off_speaker(ws, monkeypatch, (1, 2))
    # The same stretch again writes nothing, so nothing new is archived or restorable.
    assert _off_speaker(ws, monkeypatch, (1, 2))["applied_count"] == 0
    assert _states(ws) == ["ready"]
    _hard_mute(ws, 3, 4)
    _mute(ws, 3, 4, action_id="again")
    last = EditService(ws).list_applied_edits()["records"][-1]
    assert last["restore"]["state"] == "history_only"


def _only_the_first_record(ws):
    return EditService(ws).list_applied_edits()["records"][0]["restore"]


def test_an_overlapping_later_mute_that_cannot_be_undone_blocks_the_earlier_restore(tmp_path):
    ws = _workspace(tmp_path)
    _mute(ws, 1, 2, action_id="first")
    _hard_mute(ws, 2.2, 3.5)
    _mute(ws, 1.5, 3, action_id="later")
    first, later = _ids(ws)
    records = {r["id"]: r["restore"] for r in EditService(ws).list_applied_edits()["records"]}
    assert records[later]["state"] == "history_only"
    assert records[first]["state"] == "blocked"
    assert records[first]["code"] == "overlapped_by_unrestorable_mute"
    assert records[first]["blocked_by"] == []
    assert "History Undo" in records[first]["message"]
    before = _digest(ws)
    result = EditService(ws).revert_applied([first])
    assert result["status"] == "conflict"
    assert _digest(ws) == before


def test_a_disjoint_later_mute_that_cannot_be_undone_does_not_block(tmp_path):
    ws = _workspace(tmp_path)
    _mute(ws, 1, 2, action_id="first")
    _hard_mute(ws, 3.5, 4.5)
    _mute(ws, 3, 4, action_id="later")
    assert _only_the_first_record(ws)["state"] == "ready"
    assert EditService(ws).revert_applied(_ids(ws)[:1])["status"] == "restored"
    spans = [(r.start_s, r.end_s) for r in load_project(ws.path).clips[0].mute_regions]
    assert (1, 2) not in spans
    assert any(a <= 3 and b >= 4 for a, b in spans)


def test_a_later_mute_with_no_determinable_span_blocks_the_earlier_restore(tmp_path):
    ws = _workspace(tmp_path)
    _mute(ws, 1, 2, action_id="first")

    def write(p):
        archive_timeline_op(
            p, operation="something_else", track_ids=["host"], params={"action": "mute"}
        )

    ws.mutate("before", "after", write)
    state = _only_the_first_record(ws)
    assert (state["state"], state["code"]) == ("blocked", "overlapped_by_unrestorable_mute")


def test_a_later_history_only_mute_of_the_other_ownership_does_not_block(tmp_path, monkeypatch):
    ws = _workspace(tmp_path)
    _off_speaker(ws, monkeypatch, (1, 2))
    _hard_mute(ws, 1.5, 2.5)
    _mute(ws, 1, 2.2, action_id="ordinary")
    assert _only_the_first_record(ws)["state"] == "ready"


def test_a_later_cut_does_not_block_an_earlier_mute_restore(tmp_path):
    ws = _workspace(tmp_path)
    _mute(ws, 1, 2, action_id="first")
    svc = EditService(ws)
    svc.edit_selected_range(
        [svc.selected_range_target(1.2, 1.8, ["host"])],
        "cut",
        propose=False,
        reason="host:range",
        action_id="cut",
    )
    assert _only_the_first_record(ws)["state"] == "ready"


def _ripple_after_mute(tmp_path):
    ws = _workspace(tmp_path)
    _mute(ws, 1, 5, action_id="mute")

    def propose(p):
        p.edit_decisions = [_cut("cut", 3, 5, reason="filler:um")]

    ws.mutate("before", "after", propose)
    assert EditService(ws).approve(["cut"]) == 1
    return ws


def test_a_mute_is_not_restorable_ahead_of_a_later_ripple_cut_through_it(tmp_path):
    ws = _ripple_after_mute(tmp_path)
    mute, cut = _ids(ws)
    result = EditService(ws).revert_applied([mute])
    assert result["status"] == "conflict"
    assert [(c["code"], c["blocked_by"]) for c in result["conflicts"]] == [
        ("overlapped_by_later", [cut])
    ]


def test_restoring_the_mute_and_the_later_ripple_cut_together_leaves_no_mute(tmp_path):
    ws = _ripple_after_mute(tmp_path)
    assert EditService(ws).revert_applied(_ids(ws))["status"] == "restored"
    assert not any(c.mute_regions for c in load_project(ws.path).clips)


def test_restoring_the_ripple_cut_first_then_the_mute_leaves_no_mute(tmp_path):
    ws = _ripple_after_mute(tmp_path)
    mute, cut = _ids(ws)
    assert EditService(ws).revert_applied([cut])["status"] == "restored"
    assert EditService(ws).revert_applied([mute])["status"] == "restored"
    assert not any(c.mute_regions for c in load_project(ws.path).clips)


def test_a_guest_is_not_sent_to_history_when_a_later_mute_cannot_be_undone(tmp_path):
    ws = _workspace(tmp_path)
    _mute(ws, 1, 2, action_id="first")
    _hard_mute(ws, 1.5, 2.5)
    _mute(ws, 1.5, 2.5, action_id="later")
    first = _ids(ws)[0]
    host = EditService(ws).revert_applied([first])
    assert [c["code"] for c in host["conflicts"]] == ["overlapped_by_unrestorable_mute"]
    assert "History Undo" in host["conflicts"][0]["message"]
    reply = _guest_submit(ws, [first], dry_run=False)
    [conflict] = reply["restore_conflicts"]
    assert conflict["code"] == "overlapped_by_unrestorable_mute"
    assert "History" not in conflict["message"]
    assert "Ask the host" in conflict["message"]


def test_two_mutes_of_one_batch_over_a_duplicated_source_are_both_history_only(tmp_path):
    base = _project(tmp_path / "seed")
    sources = [SourceRecording(id="a", path="raw/host.wav", speaker="Host", duration_sec=6)]
    clips = [
        Clip(
            id="one", track_id="host", source_id="a", source_start=0, source_end=3, timeline_start=0
        ),
        Clip(
            id="two", track_id="host", source_id="a", source_start=0, source_end=3, timeline_start=3
        ),
    ]
    assert base.clips
    ws = _workspace(tmp_path / "ws", clips=clips, sources=sources)
    svc = EditService(ws)
    svc.edit_selected_range(
        [svc.selected_range_target(1, 2, ["host"]), svc.selected_range_target(4.5, 5.5, ["host"])],
        "mute",
        propose=False,
        reason="host:range",
        action_id="batch",
    )
    first, second = EditService(ws).list_applied_edits()["records"]
    assert (first["restore"]["state"], second["restore"]["state"]) == ("history_only",) * 2


def _duplicated_source_workspace(root, *, second_regions=()):
    sources = [SourceRecording(id="a", path="raw/host.wav", speaker="Host", duration_sec=6)]
    clips = [
        Clip(
            id="one", track_id="host", source_id="a", source_start=0, source_end=3, timeline_start=0
        ),
        Clip(
            id="two",
            track_id="host",
            source_id="a",
            source_start=0,
            source_end=3,
            timeline_start=3,
            mute_regions=list(second_regions),
        ),
    ]
    return _workspace(root, clips=clips, sources=sources)


def test_batch_exactness_does_not_depend_on_clip_order(tmp_path):
    ws = _duplicated_source_workspace(tmp_path)
    svc = EditService(ws)
    svc.edit_selected_range(
        [svc.selected_range_target(4.5, 5.5, ["host"]), svc.selected_range_target(1, 2, ["host"])],
        "mute",
        propose=False,
        reason="host:range",
        action_id="batch",
    )
    assert [r["restore"]["state"] for r in svc.list_applied_edits()["records"]] == [
        "history_only",
        "history_only",
    ]


def test_restoring_an_approved_mute_still_clears_every_clip_of_the_recording(tmp_path):
    project = _project(tmp_path / "x")
    project.sources.append(
        SourceRecording(id="a", path="raw/host.wav", speaker="Host", duration_sec=6)
    )
    project.clips = [
        Clip(
            id="one",
            track_id="host",
            source_id=None,
            source_start=0,
            source_end=3,
            timeline_start=0,
        ),
        Clip(
            id="two", track_id="host", source_id="a", source_start=3, source_end=6, timeline_start=3
        ),
    ]
    mute = _cut("mute", 2.5, 3.5, reason="filler:um")
    mute.type = EditDecisionType.MUTE
    project.edit_decisions = [mute]
    REFINE_GATE.mark_done(project, notes="Known synthetic fixture; no real-project acceptance")
    ws = ProjectWorkspace.open(save_project(project))
    assert EditService(ws).approve(["mute"]) == 1
    assert all(c.mute_regions for c in ws.project.clips)
    assert EditService(ws).revert_applied(_ids(ws))["status"] == "restored"
    assert not any(c.mute_regions for c in load_project(ws.path).clips)


def test_a_span_with_no_source_id_never_reaches_a_clip_of_another_source(tmp_path):
    sources = [SourceRecording(id="a", path="raw/host.wav", speaker="Host", duration_sec=6)]
    clips = [
        Clip(
            id="one",
            track_id="host",
            source_id=None,
            source_start=0,
            source_end=3,
            timeline_start=0,
        ),
        Clip(
            id="two",
            track_id="host",
            source_id="a",
            source_start=0,
            source_end=3,
            timeline_start=3,
            mute_regions=[ClipMuteRegion(start_s=1.2, end_s=1.8)],
        ),
    ]
    ws = _workspace(tmp_path, clips=clips, sources=sources)
    _mute(ws, 1, 2, action_id="m")
    assert _states(ws) == ["ready"]
    assert EditService(ws).revert_applied(_ids(ws))["status"] == "restored"
    by_id = {c.id: c for c in load_project(ws.path).clips}
    assert by_id["one"].mute_regions == []
    assert [(r.start_s, r.end_s) for r in by_id["two"].mute_regions] == [(1.2, 1.8)]


def _two_source_workspace(root):
    sources = [
        SourceRecording(id=name, path="raw/host.wav", speaker="Host", duration_sec=6)
        for name in ("a", "b")
    ]
    clips = [
        Clip(
            id="one", track_id="host", source_id="a", source_start=0, source_end=3, timeline_start=0
        ),
        Clip(
            id="two", track_id="host", source_id="b", source_start=0, source_end=3, timeline_start=3
        ),
    ]
    return _workspace(root, clips=clips, sources=sources)


def _two_source_mutes(ws, monkeypatch, off_speaker, spans):
    for n, (start, end) in enumerate(spans):
        if off_speaker:
            _off_speaker(ws, monkeypatch, (start, end))
        else:
            _mute(ws, start, end, action_id=f"r{n}")


@pytest.mark.parametrize("off_speaker", [False, True])
def test_a_kept_mute_of_another_source_does_not_claim_the_restored_span(
    tmp_path, monkeypatch, off_speaker
):
    ws = _two_source_workspace(tmp_path)
    _two_source_mutes(ws, monkeypatch, off_speaker, [(4, 5), (1, 2)])
    first, second = _ids(ws)
    assert _states(ws) == ["ready", "ready"]
    assert EditService(ws).revert_applied([second])["status"] == "restored"
    one, two = (c for c in sorted(load_project(ws.path).clips, key=lambda c: c.id))
    regions = (lambda c: c.off_speaker_mute_regions) if off_speaker else (lambda c: c.mute_regions)
    assert regions(one) == []
    assert len(regions(two)) == 1
    assert _ids(ws) == [first]


@pytest.mark.parametrize("off_speaker", [False, True])
def test_mutes_of_different_sources_do_not_block_each_other(tmp_path, monkeypatch, off_speaker):
    ws = _two_source_workspace(tmp_path)
    _two_source_mutes(ws, monkeypatch, off_speaker, [(1, 2), (4, 5)])
    assert _states(ws) == ["ready", "ready"]
    assert EditService(ws).revert_applied(_ids(ws)[:1])["status"] == "restored"


def test_a_span_without_a_source_shares_one_only_with_another_without(tmp_path):
    def none_pair(root, second_source):
        sources = [SourceRecording(id="a", path="raw/host.wav", speaker="Host", duration_sec=6)]
        clips = [
            Clip(
                id="one",
                track_id="host",
                source_id=None,
                source_start=0,
                source_end=3,
                timeline_start=0,
            ),
            Clip(
                id="two",
                track_id="host",
                source_id=second_source,
                source_start=0,
                source_end=3,
                timeline_start=3,
            ),
        ]
        ws = _workspace(root, clips=clips, sources=sources)
        _mute(ws, 1, 2, action_id="r0")
        _mute(ws, 4, 5, action_id="r1")
        return _states(ws)

    assert none_pair(tmp_path / "a", "a") == ["ready", "ready"]
    assert none_pair(tmp_path / "n", None) == ["blocked", "history_only"]
