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
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import EditDecisionType, load_project, save_project
from podcast_mcp.project.store import history_index_path, history_snapshot_ids
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document import EditService, HistoryService
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
    assert ripple["inverse"]["kind"] == "reinsert_clips"
    assert trim["restore"]["state"] == "history_only"
    assert trim["inverse"] is None
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

    plans, conflicts = plan_restores(project, [record.id])
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
    ws = _ripple_workspace(tmp_path)
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
    ws = _ripple_workspace(tmp_path)
    record_id = ws.project.editorial.edit_log[0].id
    reply = _guest_submit(ws, [record_id], dry_run=dry_run)
    assert reply["command"] == {"type": "RestoreAppliedEdit"}
    assert [c["code"] for c in reply["restore_conflicts"]] == ["local_restore_requires_history"]


def test_guest_dry_run_plan_reply_hides_command_payload(tmp_path):
    ws = _mute_workspace(tmp_path)
    reply = _guest_submit(ws, [ws.project.editorial.edit_log[0].id], dry_run=True)
    assert reply["command"] == {"type": "RestoreAppliedEdit"}
    assert "restore_conflicts" not in reply


@pytest.mark.parametrize("surface", SURFACES)
def test_conflict_leaves_no_journal_row_and_no_server_seq(tmp_path, surface):
    ws = _ripple_workspace(tmp_path)
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
