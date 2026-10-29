from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from mcp.client import Client

from pause_policy_public_helpers import (
    configure,
    defaults,
    project,
    room,
    voice,
    workspace,
    write_wav,
)
from podcast_mcp.edits.decisions import AskedEdits, HeldEdit
from podcast_mcp.edits.review_gate import ReviewRequiredError
from podcast_mcp.edits.transcript_refine_status import GATE_HINT, TranscriptRefineRequiredError
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.mcp.tools.edits import propose_edits
from podcast_mcp.mcp.tools.history import history_list, history_status_tool, history_undo
from podcast_mcp.models import (
    EditDecision,
    EditDecisionType,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.util.coded_error import CodedError, CodedPermissionError, CodedValueError

pytestmark = pytest.mark.refine_gate

_REPLY_KEYS = {"operation", "edits", "skip_counts", "summary"}
_EDIT_KEYS = {
    "id",
    "track_id",
    "type",
    "start",
    "end",
    "crossfade_ms",
    "reason",
    "author",
    "review_required",
    "applied",
    "cut_confidence",
    "boundary_mode",
    "replace_gap_sec",
    "next_burst_sec",
    "scope",
    "cut_speech",
    "track_ids",
    "timebase",
    "source_id",
    "source_timeline_span",
    "exact_range",
    "proposal_origin",
    "boundary_intent",
    "kind",
    "sound_kind",
    "label",
    "suggested_action",
    "audio_check",
}
_HELD_REASON = "Guest is speaking where the session cut would remove it"
_HELD_SUMMARY = (
    "1 proposed (1 filler, 0 pause); 1 of them the audio checks would hold "
    "(`podcast edit held` lists each with its reason)"
)
_CLEAN_SUMMARY = "1 proposed (1 filler, 0 pause)"
_NONE_SUMMARY = "0 proposed (0 filler, 0 pause)"
_INTENSITY_ERROR = "unknown tighten intensity 'extreme'; expected one of: light, medium, aggressive"


def _stale(edit_id: str = "stale", reason: str = "filler:um:old") -> EditDecision:
    return EditDecision(
        id=edit_id,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=3.0,
        end=3.2,
        reason=reason,
        applied=False,
        review_required=False,
    )


def _path(
    tmp_path: Path,
    monkeypatch,
    *,
    peer: bool = True,
    filler: bool = True,
    gate: bool = True,
    existing: list[EditDecision] | None = None,
) -> str:
    cfg = defaults()
    cfg["tighten"].update({"filler_words": ["um"], "max_pause_sec": 100})
    cfg["tighten"]["speech_energy_guard"].update({"enabled": True, "on_conflict": "review"})
    configure(monkeypatch, cfg)
    root = tmp_path / "ws"
    root.mkdir(parents=True)
    result = project(root, guest="quiet")
    if filler:
        result.transcripts[0].words.insert(1, TranscriptWord(text="um", start=1, end=1.5))
    host = room()
    for start, end in ((0, 0.2), (1.02, 1.46), (5, 5.2)):
        voice(host, start, end)
    write_wav(root / "raw" / "host.wav", host)
    guest = room(seed=1215)
    if peer:
        voice(guest, 1.1, 1.3)
    write_wav(root / "raw" / "guest.wav", guest)
    result.edit_decisions = list(existing or [])
    if gate:
        return str(workspace(result).path)
    return str(save_project(result))


def _decisions(path: str) -> list[EditDecision]:
    return load_project(Path(path)).edit_decisions


def _history(path: str) -> dict:
    return json.loads(history_status_tool(path))


def _labels(path: str) -> list[str]:
    return [e["label"] for e in json.loads(history_list(path))["entries"]]


def _rows(path: str) -> list[dict]:
    return DocumentSyncService.open(path).store.commands_after(0)


def _journal(path: str) -> list[str]:
    return [r["type"] for r in _rows(path)]


def _run(path: str, **kwargs) -> dict:
    return json.loads(propose_edits(path, **kwargs))


def _registered(args: dict, name: str = "propose_edits"):
    async def call():
        async with Client(mcp_server.mcp) as client:
            return await client.call_tool(name, args)

    return asyncio.run(call())


def test_reply_keys_and_one_edit_row(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    reply = _run(path)
    assert set(reply) == _REPLY_KEYS
    assert reply["operation"] == "propose_edits"
    for absent in ("held", "checked", "edit_mode", "intensity"):
        assert absent not in reply
    assert reply["skip_counts"] == {}
    assert reply["summary"] == _HELD_SUMMARY
    (edit,) = reply["edits"]
    assert set(edit) == _EDIT_KEYS
    assert edit["id"] == "cut_filler_1000_1500_4740ae6347"
    assert (edit["track_id"], edit["type"], edit["start"], edit["end"]) == (
        "host",
        "remove",
        1,
        1.5,
    )
    assert edit["reason"] == "filler:um:interior_speech:other_speaking:guest"
    assert (edit["scope"], edit["review_required"], edit["applied"]) == ("session", True, False)
    assert (edit["kind"], edit["sound_kind"], edit["label"]) == ("filler", "filler", "Filler word")
    assert edit["suggested_action"] == "cut"
    assert edit["audio_check"] == {"status": "held", "reason": _HELD_REASON}


def test_a_clean_proposal_says_clean_and_the_summary_names_no_hold(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch, peer=False)
    reply = _run(path)
    (edit,) = reply["edits"]
    assert edit["audio_check"] == {"status": "clean"}
    assert (edit["scope"], edit["review_required"]) == ("session", False)
    assert reply["summary"] == _CLEAN_SUMMARY


def test_the_proposal_is_saved_as_pending_decisions_and_nothing_is_applied(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    assert _decisions(path) == []
    reply = _run(path)
    (saved,) = _decisions(path)
    assert saved.id == reply["edits"][0]["id"]
    assert (saved.applied, saved.review_required) == (False, True)
    assert len(load_project(Path(path)).clips) == 2
    assert load_project(Path(path)).timeline.duration_sec == 6


def test_history_gets_a_before_and_an_after_row_and_undo_removes_the_proposal(
    tmp_path, monkeypatch
):
    path = _path(tmp_path, monkeypatch)
    _run(path)
    assert _history(path)["total"] == 2
    assert _labels(path) == ["before propose edits", "after propose edits"]
    entries = json.loads(history_list(path))["entries"]
    assert [e["operation"] for e in entries] == [None, None]
    assert [e["params"] for e in entries] == [None, None]
    assert [e["current"] for e in entries] == [False, True]
    history_undo(path)
    assert _decisions(path) == []


def test_an_identical_repeat_keeps_one_proposal_and_adds_no_history_row(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    first = _run(path)
    second = _run(path)
    assert second == first
    assert [d.id for d in _decisions(path)] == [first["edits"][0]["id"]]
    assert _labels(path) == ["before propose edits", "after propose edits"]
    assert _history(path)["total"] == 2


def test_earlier_generated_pending_proposals_are_replaced_and_manual_ones_kept(
    tmp_path, monkeypatch
):
    path = _path(
        tmp_path,
        monkeypatch,
        existing=[
            _stale("old-filler"),
            _stale("old-pause", "pause:1.00s"),
            _stale("manual", "nl:x"),
        ],
    )
    reply = _run(path)
    ids = [d.id for d in _decisions(path)]
    assert "old-filler" not in ids
    assert "old-pause" not in ids
    assert "manual" in ids
    assert reply["edits"][0]["id"] in ids
    assert len(ids) == 2
    assert [e["id"] for e in reply["edits"]] == [reply["edits"][0]["id"]]


def test_no_candidates_returns_an_empty_proposal_with_one_before_row_only(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch, filler=False)
    reply = _run(path)
    assert reply == {
        "operation": "propose_edits",
        "edits": [],
        "skip_counts": {},
        "summary": _NONE_SUMMARY,
    }
    assert _decisions(path) == []
    assert _labels(path) == ["before propose edits"]
    assert _history(path)["total"] == 1


def test_no_candidates_still_drops_earlier_generated_pending_proposals(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch, filler=False, existing=[_stale("old"), _stale("m", "nl:x")])
    reply = _run(path)
    assert reply["edits"] == []
    assert [d.id for d in _decisions(path)] == ["m"]


def test_the_audit_check_is_not_run_when_there_is_nothing_proposed(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch, filler=False)
    calls: list = []
    monkeypatch.setattr(
        EditService, "held_by_checks", lambda self, ids=None: calls.append(ids) or ([], [])
    )
    ws = ProjectWorkspace.open(path)
    proposal = EditService(ws).propose_tighten()
    assert calls == []
    assert (proposal.held, proposal.checked) == ({}, False)


def test_intensity_and_edit_mode_change_the_proposal(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch, peer=False)
    assert _run(path)["edits"][0]["type"] == "remove"
    assert _run(path, edit_mode="mute")["edits"][0]["type"] == "mute"
    assert _run(path, edit_mode="MUTE")["edits"][0]["type"] == "mute"
    assert _run(path, intensity="light")["edits"] == []
    assert _run(path, intensity=" Light ")["edits"] == []
    assert len(_run(path, intensity="aggressive")["edits"]) == 1
    assert len(_run(path, intensity="medium")["edits"]) == 1


def test_blank_values_mean_the_default(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch, peer=False)
    assert _run(path, intensity="")["edits"][0]["type"] == "remove"
    assert _run(path, edit_mode="")["edits"][0]["type"] == "remove"


def test_an_unknown_edit_mode_is_not_an_error_it_means_ripple(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch, peer=False)
    reply = _run(path, edit_mode="bogus")
    assert reply["edits"][0]["type"] == "remove"
    assert _labels(path) == ["before propose edits", "after propose edits"]


def test_an_unknown_intensity_is_a_coded_value_error_and_changes_nothing(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    before = Path(path).read_bytes()
    with pytest.raises(CodedValueError) as raised:
        _run(path, intensity="extreme")
    assert raised.value.code == "pipeline_config_value_invalid"
    assert str(raised.value) == _INTENSITY_ERROR
    assert isinstance(raised.value, ValueError)
    assert Path(path).read_bytes() == before
    assert _history(path)["total"] == 0
    assert _journal(path) == []


def test_a_pending_refine_gate_refuses_before_anything_is_written(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch, gate=False)
    before = Path(path).read_bytes()
    with pytest.raises(TranscriptRefineRequiredError) as raised:
        _run(path)
    assert isinstance(raised.value, ReviewRequiredError)
    assert isinstance(raised.value, CodedError)
    assert isinstance(raised.value, RuntimeError)
    assert not isinstance(raised.value, ValueError)
    assert raised.value.code == "transcript_refine_required"
    assert str(raised.value) == GATE_HINT
    assert Path(path).read_bytes() == before
    assert _history(path)["total"] == 0
    assert _journal(path) == []


def test_the_gate_is_checked_before_the_intensity(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch, gate=False)
    with pytest.raises(TranscriptRefineRequiredError):
        _run(path, intensity="extreme")


def test_a_missing_project_is_a_file_not_found(tmp_path):
    missing = str(tmp_path / "nope")
    with pytest.raises(FileNotFoundError, match="Project not found"):
        _run(missing)


def test_the_service_records_held_and_checked_on_the_proposal(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    proposal = EditService(ProjectWorkspace.open(path)).propose_tighten()
    (edit_id,) = (d.id for d in proposal.decisions)
    assert proposal.checked is True
    assert proposal.held == {edit_id: _HELD_REASON}
    clean = _path(tmp_path / "c", monkeypatch, peer=False)
    proposal = EditService(ProjectWorkspace.open(clean)).propose_tighten()
    assert (proposal.held, proposal.checked) == ({}, True)


def test_the_check_runs_after_the_proposal_is_saved_and_saves_nothing_itself(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    seen: list[tuple] = []

    def spy(self, ids=None):
        seen.append((list(ids), _history(path)["total"], [d.applied for d in _decisions(path)]))
        return [], []

    monkeypatch.setattr(EditService, "held_by_checks", spy)
    reply = _run(path)
    assert seen == [([reply["edits"][0]["id"]], 2, [False])]
    assert _history(path)["total"] == 2


def test_a_held_edit_is_rechecked_without_the_hold_until_a_pass_finds_none(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    calls: list[list[str]] = []
    edit_id = "cut_filler_1000_1500_4740ae6347"

    def listing(self, ids=None):
        calls.append(list(ids))
        return ([HeldEdit(edit_id, "um", "stub hold")], []) if len(calls) == 1 else ([], [])

    monkeypatch.setattr(EditService, "held_by_checks", listing)
    reply = _run(path)
    assert calls == [[edit_id]]
    assert reply["edits"][0]["audio_check"] == {"status": "held", "reason": "stub hold"}
    assert reply["summary"] == _HELD_SUMMARY


def test_an_asked_group_is_recorded_as_held_with_the_confirmation_message(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    edit_id = "cut_filler_1000_1500_4740ae6347"
    calls: list[list[str]] = []

    def listing(self, ids=None):
        calls.append(list(ids))
        ask = AskedEdits((edit_id,), SimpleNamespace(message="stub confirmation"))
        return [], ([ask] if len(calls) == 1 else [])

    monkeypatch.setattr(EditService, "held_by_checks", listing)
    reply = _run(path)
    assert calls == [[edit_id]]
    assert reply["edits"][0]["audio_check"] == {"status": "held", "reason": "stub confirmation"}


@pytest.mark.parametrize("failure", [OSError("decode failed"), RuntimeError("unexpected")])
def test_a_failing_check_is_swallowed_and_the_proposal_is_returned_unchecked(
    tmp_path, monkeypatch, failure
):
    path = _path(tmp_path, monkeypatch)

    def broken(self, ids=None):
        raise failure

    monkeypatch.setattr(EditService, "held_by_checks", broken)
    reply = _run(path)
    (edit,) = reply["edits"]
    assert "audio_check" not in edit
    assert set(edit) == _EDIT_KEYS - {"audio_check"}
    assert reply["summary"] == _CLEAN_SUMMARY
    assert len(_decisions(path)) == 1
    assert _labels(path) == ["before propose edits", "after propose edits"]
    assert _journal(path) == ["ExternalMutate"]


def test_a_failing_check_leaves_held_and_checked_at_their_defaults(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    monkeypatch.setattr(
        EditService, "held_by_checks", lambda self, ids=None: (_ for _ in ()).throw(OSError("x"))
    )
    proposal = EditService(ProjectWorkspace.open(path)).propose_tighten()
    assert (proposal.held, proposal.checked) == ({}, False)
    assert len(proposal.decisions) == 1


def test_a_direct_tool_call_journals_one_external_mutate_row(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    _run(path)
    (row,) = _rows(path)
    assert row["type"] == "ExternalMutate"
    assert row["client_id"] == "server:external"
    assert row["role"] == "agent"
    assert row["payload"] == {"projection": "shell"}


def test_the_service_alone_journals_nothing(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    EditService(ProjectWorkspace.open(path)).propose_tighten()
    assert _journal(path) == []
    assert _history(path)["total"] == 2


def test_a_no_candidate_call_still_journals_one_row(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch, filler=False)
    _run(path)
    assert _journal(path) == ["ExternalMutate"]


def test_a_failed_call_journals_nothing(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    with pytest.raises(CodedValueError):
        _run(path, intensity="extreme")
    assert _journal(path) == []


def test_the_registered_tool_returns_the_same_reply_and_journals_one_row(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    result = _registered({"project_path": path})
    assert not result.is_error
    reply = json.loads(result.content[0].text)
    assert set(reply) == _REPLY_KEYS
    assert reply["summary"] == _HELD_SUMMARY
    assert _journal(path) == ["ExternalMutate"]
    assert [r["client_id"] for r in _rows(path)] == ["server:external"]


def test_the_registered_tool_second_call_journals_a_second_row(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    _registered({"project_path": path})
    _registered({"project_path": path})
    assert _journal(path) == ["ExternalMutate", "ExternalMutate"]


def test_the_registered_tool_passes_its_arguments_through(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch, peer=False)
    result = _registered({"project_path": path, "edit_mode": "mute", "intensity": "aggressive"})
    assert json.loads(result.content[0].text)["edits"][0]["type"] == "mute"


def test_the_registered_tool_reports_coded_errors_with_their_codes(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    result = _registered({"project_path": path, "intensity": "extreme"})
    assert result.is_error
    assert result.structured_content == {
        "ok": False,
        "error": _INTENSITY_ERROR,
        "error_code": "pipeline_config_value_invalid",
    }
    assert _journal(path) == []
    assert _history(path)["total"] == 0


def test_the_registered_tool_reports_the_refine_gate_with_its_code(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch, gate=False)
    result = _registered({"project_path": path})
    assert result.is_error
    assert result.structured_content == {
        "ok": False,
        "error": GATE_HINT,
        "error_code": "transcript_refine_required",
    }
    assert _journal(path) == []


def test_the_registered_tool_rejects_a_non_string_intensity_before_the_service(
    tmp_path, monkeypatch
):
    path = _path(tmp_path, monkeypatch)
    result = _registered({"project_path": path, "intensity": 5})
    assert result.is_error
    assert "intensity" in result.content[0].text
    assert _journal(path) == []
    assert _history(path)["total"] == 0


def test_the_tool_is_registered_as_propose_edits_and_there_is_no_propose_tighten_tool():
    async def names():
        async with Client(mcp_server.mcp) as client:
            return {t.name for t in (await client.list_tools()).tools}

    found = asyncio.run(names())
    assert "propose_edits" in found
    assert "propose_tighten" not in found


def test_there_is_no_propose_tighten_document_command_yet(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    before = Path(path).read_bytes()
    command = DocumentCommand(
        type="ProposeTighten", payload={}, client_id="mcp-agent", client_seq=None, role="guest"
    )
    with pytest.raises(CodedPermissionError) as raised:
        DocumentSyncService.open(path).submit(command, capabilities=capabilities_for_role("editor"))
    assert raised.value.code == "share_capability_required"
    assert str(raised.value) == "share capabilities do not allow document command: ProposeTighten"
    host = DocumentCommand(
        type="ProposeTighten", payload={}, client_id="host", client_seq=None, role="host"
    )
    with pytest.raises(CodedValueError) as unknown:
        DocumentSyncService.open(path).submit(host)
    assert unknown.value.code == "document_command_unknown"
    assert str(unknown.value) == "unknown document command: ProposeTighten"
    assert Path(path).read_bytes() == before
    assert _journal(path) == []
