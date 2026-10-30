"""Apply suggested actions holds a cut over an unsure word (#2518); the race in the approve guard."""

from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.models import Transcript, TranscriptWord, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document import EditService, HistoryService
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.services.document_sync.handlers import edits as handlers
from podcast_mcp.services.document_sync.host_submit import host_command_result
from podcast_mcp.services.document_sync.payloads import ApplySuggestedActionsPayload
from source_review_helpers import _cut, _project

pytestmark = pytest.mark.refine_gate

WORDS = [
    ("so", 0.5, 0.95),
    ("uncle", 3.0, 0.4),
    ("said", 3.5, 0.95),
    ("fine", 4.0, 0.95),
    ("well", 5.0, 0.69),
    ("okay", 5.5, 0.7),
]


def _fillers(*spans: tuple[str, float, float]):
    return [_cut(i, a, b, reason="filler:um", review_required=True) for i, a, b in spans]


CLEAN = ("clean", 4.0, 4.4)
UNSURE = ("uncle", 3.0, 3.2)
EDGE = ("edge", 3.3, 3.45)


def _open(tmp_path, *spans, gate=True):
    project = _project(tmp_path)
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text=t, start=s, end=s + 0.3, confidence=c) for t, s, c in WORDS],
        )
    ]
    project.edit_decisions = _fillers(*(spans or (CLEAN, UNSURE, EDGE)))
    if gate:
        REFINE_GATE.mark_done(
            project, notes="Known synthetic transcript fixture; no real-project test"
        )
    return ProjectWorkspace.open(save_project(project))


def _steps(ws) -> int:
    return len(HistoryService(ProjectWorkspace.open(ws.path)).list_entries().entries)


def _pending(ws) -> list[str]:
    return sorted(e.id for e in load_project(ws.path).edit_decisions if not e.applied)


def _apply(ws, **payload):
    return handlers.apply_suggested_actions(ws, {"_boundary_intent": "programmatic", **payload})


def _guest(role="editor", **payload) -> tuple[DocumentCommand, list[str]]:
    command = DocumentCommand(
        type="ApplySuggestedActions",
        payload=payload,
        client_id="guest",
        client_seq=None,
        role="guest",
    )
    return command, capabilities_for_role(role)


def _submit_guest(ws, role="editor", **payload):
    command, caps = _guest(role, **payload)
    outcome = DocumentSyncService.open(ws.path).submit(
        command, capabilities=caps, range_policy="apply"
    )
    return host_command_result(outcome)


# --- the flag on the host path -------------------------------------------------------------


def test_skip_unsure_holds_the_cut_over_an_unsure_word_and_applies_the_rest_in_one_step(tmp_path):
    ws = _open(tmp_path)
    steps = _steps(ws)

    out = _apply(ws, skip_unsure=True)

    assert out["applied"] == {"cut": 2}
    assert out["held"] == ["uncle"]
    assert out["held_unsure"] == ["uncle"]
    assert "1 still pending" in out["summary"] and "unsure" in out["summary"]
    assert _pending(ws) == ["uncle"]
    assert _steps(ws) - steps == 2  # one before/after pair for the whole batch


def test_without_the_flag_the_host_batch_cuts_the_unsure_word(tmp_path):
    ws = _open(tmp_path)
    out = _apply(ws)
    assert out["applied"] == {"cut": 3} and out["held"] == [] and out["held_unsure"] == []
    assert _pending(ws) == []


def test_the_flag_with_nothing_unsure_changes_nothing(tmp_path):
    ws = _open(tmp_path, CLEAN, ("clean2", 0.5, 0.7))
    steps = _steps(ws)
    out = _apply(ws, skip_unsure=True)
    assert out["applied"] == {"cut": 2} and out["held"] == [] and out["held_unsure"] == []
    assert _steps(ws) - steps == 2


def test_when_every_cut_is_held_nothing_is_saved_and_no_step_is_added(tmp_path):
    ws = _open(tmp_path, UNSURE, ("well", 5.0, 5.2))
    before, steps = ws.path.read_bytes(), _steps(ws)
    out = _apply(ws, skip_unsure=True)
    assert out["applied"] == {} and out["applied_count"] == 0
    assert out["held"] == ["uncle", "well"] and out["held_unsure"] == ["uncle", "well"]
    assert ws.path.read_bytes() == before
    assert _steps(ws) == steps


def test_a_cut_the_batch_leaves_is_not_an_unsure_cut(tmp_path):
    ws = _open(tmp_path)
    out = _apply(ws, skip_unsure=True, overrides={"uncle": "leave"})
    assert out["held"] == [] and out["applied"] == {"cut": 2, "leave": 1}
    assert _pending(ws) == []


def test_ids_narrow_the_batch_before_the_guard(tmp_path):
    ws = _open(tmp_path)
    out = _apply(ws, ids=["clean", "uncle"], skip_unsure=True)
    assert out["held_unsure"] == ["uncle"] and out["applied"] == {"cut": 1}
    assert _pending(ws) == ["edge", "uncle"]


def test_the_guard_reads_the_saved_words_not_the_clients_view(tmp_path):
    ws = _open(tmp_path)
    project = load_project(ws.path)
    project.transcripts[0].words[3].confidence = 0.2
    save_project(project)
    out = _apply(ProjectWorkspace.open(ws.path), ids=["clean", "edge"], skip_unsure=True)
    assert out["held_unsure"] == ["clean"] and out["applied"] == {"cut": 1}


def test_the_service_default_is_off_and_the_payload_documents_the_flag():
    assert ApplySuggestedActionsPayload().skip_unsure is False
    field = ApplySuggestedActionsPayload.model_fields["skip_unsure"]
    assert "unsure" in (field.description or "") and "Studio" in (field.description or "")


# --- who may bypass it ---------------------------------------------------------------------


def test_an_editor_guest_with_the_flag_off_still_holds_the_unsure_cut(tmp_path):
    ws = _open(tmp_path)
    out = _submit_guest(ws, skip_unsure=False)
    assert out["held_unsure"] == ["uncle"] and out["applied"] == {"cut": 2}
    assert _pending(ws) == ["uncle"]


def test_an_editor_guest_that_omits_the_flag_is_guarded_even_for_one_id(tmp_path):
    ws = _open(tmp_path)
    out = _submit_guest(ws, ids=["uncle"])
    assert out["held_unsure"] == ["uncle"] and out["applied_count"] == 0
    assert _pending(ws) == ["clean", "edge", "uncle"]


def test_a_commenter_cannot_apply_suggested_actions(tmp_path):
    ws = _open(tmp_path)
    with pytest.raises(PermissionError, match="ApplySuggestedActions"):
        _submit_guest(ws, role="commenter")
    assert _pending(ws) == ["clean", "edge", "uncle"]


def test_the_host_decides_for_itself():
    from podcast_mcp.services.document_sync.policy import must_skip_unsure_suggested

    assert must_skip_unsure_suggested(None, False) is False
    assert must_skip_unsure_suggested(None, True) is True
    assert must_skip_unsure_suggested(["edit"], False) is True
    assert must_skip_unsure_suggested(["suggest"], False) is True


def test_a_host_command_through_the_bus_without_the_flag_cuts(tmp_path):
    ws = _open(tmp_path)
    command = DocumentCommand(
        type="ApplySuggestedActions", payload={}, client_id="cli", client_seq=None, role="host"
    )
    out = host_command_result(DocumentSyncService.open(ws.path).submit(command))
    assert out["held"] == [] and _pending(ws) == []


# --- CLI and MCP ---------------------------------------------------------------------------


def test_cli_apply_suggested_all_leaves_unsure_cuts_pending_and_says_how_to_cut_one(tmp_path):
    ws = _open(tmp_path)
    done = CliRunner().invoke(app, ["edit", "apply-suggested", "--project", str(ws.path)])
    assert done.exit_code == 0, done.output
    assert "Applied 2 cut" in done.output and "1 still pending" in done.output
    assert "Held uncle:" in done.output and "--ids <id>" in done.output
    assert _pending(ws) == ["uncle"]


def test_cli_apply_suggested_one_id_cuts_the_unsure_word(tmp_path):
    ws = _open(tmp_path)
    done = CliRunner().invoke(
        app, ["edit", "apply-suggested", "--project", str(ws.path), "--ids", "uncle"]
    )
    assert done.exit_code == 0, done.output
    assert "Applied 1 cut" in done.output and "Held" not in done.output
    assert _pending(ws) == ["clean", "edge"]


def test_cli_apply_suggested_several_ids_hold_the_unsure_cut(tmp_path):
    ws = _open(tmp_path)
    done = CliRunner().invoke(
        app, ["edit", "apply-suggested", "--project", str(ws.path), "--ids", "clean,uncle"]
    )
    assert done.exit_code == 0, done.output
    assert "Held uncle:" in done.output
    assert _pending(ws) == ["edge", "uncle"]


def test_cli_apply_suggested_all_with_one_pending_unsure_cut_holds_it(tmp_path):
    ws = _open(tmp_path, UNSURE)
    steps = _steps(ws)
    done = CliRunner().invoke(app, ["edit", "apply-suggested", "--project", str(ws.path)])
    assert done.exit_code == 0, done.output
    assert "Held uncle:" in done.output
    assert _pending(ws) == ["uncle"] and _steps(ws) == steps


def test_mcp_apply_suggested_all_holds_unsure_cuts(tmp_path):
    from podcast_mcp.mcp.tools.edits import apply_suggested_actions_tool

    ws = _open(tmp_path)
    out = json.loads(apply_suggested_actions_tool(str(ws.path)))
    assert out["applied"] == {"cut": 2}
    assert out["held"] == ["uncle"] and out["held_unsure"] == ["uncle"]
    assert _pending(ws) == ["uncle"]


def test_mcp_apply_suggested_one_id_cuts_and_several_ids_hold(tmp_path):
    from podcast_mcp.mcp.tools.edits import apply_suggested_actions_tool

    ws = _open(tmp_path)
    one = json.loads(apply_suggested_actions_tool(str(ws.path), ids=["uncle"]))
    assert one["applied"] == {"cut": 1} and one["held"] == []
    ws = _open(tmp_path / "again", CLEAN, UNSURE)
    several = json.loads(apply_suggested_actions_tool(str(ws.path), ids=["clean", "uncle"]))
    assert several["held_unsure"] == ["uncle"] and several["applied"] == {"cut": 1}


def test_the_tool_description_says_what_is_held_and_how_to_cut_one():
    from podcast_mcp.mcp.tools.edits import apply_suggested_actions_tool

    doc = apply_suggested_actions_tool.__doc__ or ""
    assert "analysis.unsure_word_confidence" in doc and "held_unsure" in doc


# --- the approve guard: a save between the check and the commit -----------------------------


def test_a_save_that_empties_the_approve_after_the_check_returns_zero_without_a_step(
    tmp_path, monkeypatch
):
    from podcast_mcp.services.document import edit as edit_module

    ws = _open(tmp_path, UNSURE, gate=False)
    real = edit_module.hold_unsure_cuts
    calls = {"n": 0}

    def late_save(project, ids, line, held):
        calls["n"] += 1
        if calls["n"] == 1:
            return ids  # the first look found the cut clean; a save lowered a word since
        return real(project, ids, line, held)

    monkeypatch.setattr(edit_module, "hold_unsure_cuts", late_save)
    held: list = []
    before, steps = ws.path.read_bytes(), _steps(ws)

    assert EditService(ws).approve(["uncle"], unsure_out=held) == 0

    assert [h.edit_id for h in held] == ["uncle"]
    assert ws.path.read_bytes() == before and _steps(ws) == steps


# --- no guest path to apply_edit_plan --------------------------------------------------------


def test_only_editors_reach_apply_edit_plan_and_no_guest_tool_does():
    import re
    from pathlib import Path

    import podcast_mcp
    from podcast_mcp.services.document_sync.capabilities import (
        EDIT_COMMANDS,
        ROLE_DOCUMENT_COMMANDS,
        SUGGEST_COMMANDS,
    )
    from podcast_mcp.services.remote_mcp.allowlist import ALL_GUEST_TOOLS

    assert not [t for t in ALL_GUEST_TOOLS if "edit_plan" in t]
    assert "ApplyEditPlan" in EDIT_COMMANDS
    assert "ApplyEditPlan" not in SUGGEST_COMMANDS
    granted_to = {
        role for role, granted in ROLE_DOCUMENT_COMMANDS.items() if "ApplyEditPlan" in granted
    }
    assert [role.value for role in granted_to] == ["editor"]
    root = Path(podcast_mcp.__file__).parent
    callers = {
        str(p.relative_to(root))
        for p in root.rglob("*.py")
        if re.search(r"\.apply_plan\(", p.read_text())
    }
    assert callers == {"services/document_sync/handlers/edits.py"}
