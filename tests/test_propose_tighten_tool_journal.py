from __future__ import annotations

import json
import threading
from dataclasses import replace
from pathlib import Path
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.edits.tighten.propose import TightenProposal, with_audio_check
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.mcp.tools import edits as mcp_edits
from podcast_mcp.mcp.tools.edits import propose_edits
from podcast_mcp.models import load_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document import edit as document_edit
from podcast_mcp.services.document_sync import DocumentCommand, DocumentSyncService
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.progress import (
    CancelledProgress,
    RecordingProgress,
    bind_progress,
    progress_task,
    resolve_progress_task,
)
from test_propose_tighten_tool_pin import (
    _CLEAN_SUMMARY,
    _HELD_SUMMARY,
    _REPLY_KEYS,
    _decisions,
    _history,
    _journal,
    _labels,
    _path,
    _registered,
    _rows,
    _run,
    _stale,
)

pytestmark = pytest.mark.refine_gate


def _last_command(path: str):
    return load_project(Path(path)).document_sync.last_command


def _command(payload: dict, *, role: str = "agent") -> DocumentCommand:
    return DocumentCommand(
        type="ProposeTighten", payload=payload, client_id="mcp-agent", client_seq=None, role=role
    )


def test_an_applying_call_journals_one_row_and_sets_last_command(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    assert _last_command(path) is None
    _run(path, edit_mode="ripple", intensity="aggressive")
    (row,) = _rows(path)
    assert row["type"] == "ProposeTighten"
    assert row["client_id"] == "mcp-agent"
    assert row["role"] == "agent"
    assert set(row["payload"]) == {"edit_mode", "intensity", "result"}
    assert (row["payload"]["edit_mode"], row["payload"]["intensity"]) == ("ripple", "aggressive")
    saved = _last_command(path)
    assert saved is not None
    assert saved.type == "ProposeTighten"
    assert saved.command_id == row["command_id"]
    assert json.loads(json.dumps(row)) == row


def test_a_no_candidate_call_and_an_identical_repeat_each_journal_a_row(tmp_path, monkeypatch):
    empty = _path(tmp_path / "empty", monkeypatch, filler=False)
    _run(empty)
    assert _journal(empty) == ["ProposeTighten"]
    assert _last_command(empty).type == "ProposeTighten"
    path = _path(tmp_path / "full", monkeypatch)
    _run(path)
    labels = _labels(path)
    _run(path)
    assert _journal(path) == ["ProposeTighten", "ProposeTighten"]
    assert _last_command(path).type == "ProposeTighten"
    assert _labels(path) == labels
    assert len(_decisions(path)) == 1


@pytest.mark.parametrize(
    ("kwargs", "gate", "code"),
    [
        ({"intensity": "extreme"}, True, "pipeline_config_value_invalid"),
        ({}, False, "transcript_refine_required"),
    ],
    ids=["unknown-intensity", "refine-gate"],
)
def test_an_error_writes_no_row_and_leaves_last_command_history_and_bytes_alone(
    tmp_path, monkeypatch, kwargs, gate, code
):
    path = _path(tmp_path, monkeypatch, gate=gate)
    before = Path(path).read_bytes()
    with pytest.raises(Exception) as raised:
        _run(path, **kwargs)
    assert raised.value.code == code
    assert _journal(path) == []
    assert _last_command(path) is None
    assert Path(path).read_bytes() == before
    assert _history(path)["total"] == 0


def test_a_non_string_payload_is_invalid_payload_and_writes_nothing(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    before = Path(path).read_bytes()
    with pytest.raises(CodedValueError) as raised:
        DocumentSyncService.open(path).submit(_command({"intensity": 5}))
    assert raised.value.code == "invalid_payload"
    assert _journal(path) == []
    assert Path(path).read_bytes() == before


def test_a_missing_project_writes_no_row(tmp_path):
    with pytest.raises(FileNotFoundError, match="Project not found"):
        propose_edits(str(tmp_path / "nope"))


def test_the_command_payload_defaults_to_empty():
    from podcast_mcp.services.document_sync.payloads import validate_payload

    assert validate_payload("ProposeTighten", {}) == {"edit_mode": None, "intensity": None}


def test_a_direct_and_a_registered_call_each_journal_exactly_one_row(tmp_path, monkeypatch):
    direct = _path(tmp_path / "direct", monkeypatch)
    _run(direct)
    assert _journal(direct) == ["ProposeTighten"]
    registered = _path(tmp_path / "registered", monkeypatch)
    _registered({"project_path": registered})
    assert _journal(registered) == ["ProposeTighten"]


def test_the_tool_does_not_notify_the_agent_mutation_itself(tmp_path, monkeypatch):
    from podcast_mcp.mcp.tools import agent_notify

    assert not hasattr(mcp_edits, "agent_mutated")

    def boom(*args, **kwargs):
        raise AssertionError("propose_edits must journal through the command only")

    monkeypatch.setattr(agent_notify, "agent_mutated", boom)
    monkeypatch.setattr(agent_notify, "after_agent_mutation", boom, raising=False)
    path = _path(tmp_path, monkeypatch)
    _registered({"project_path": path})
    assert "ExternalMutate" not in _journal(path)


def _synthetic(*ids: str) -> TightenProposal:
    return TightenProposal([_stale(i) for i in ids], {"discourse:so": 2})


@pytest.mark.parametrize(
    ("ids", "held", "checked"),
    [
        (("a",), {}, True),
        (("a",), {"a": "Guest is speaking"}, True),
        (("a", "b"), {"b": "Guest is speaking"}, True),
        (("a", "b"), {}, False),
        ((), {}, True),
    ],
    ids=["clean", "held", "mixed", "unchecked", "empty"],
)
def test_with_audio_check_matches_the_proposal_it_replaces(ids, held, checked):
    base = _synthetic(*ids)
    expected = replace(base, held=held, checked=checked).to_payload()
    assert with_audio_check(base.to_payload(), held, checked) == expected


def test_check_proposed_saves_nothing_and_reports_no_ids_and_failures_as_unchecked(
    tmp_path, monkeypatch
):
    path = _path(tmp_path, monkeypatch)
    reply = _run(path)
    ids = [e["id"] for e in reply["edits"]]
    before = Path(path).read_bytes()
    service = EditService(ProjectWorkspace.open(path))
    assert service.check_proposed([]) == ({}, False)
    assert service.check_proposed(ids) == (
        {ids[0]: "Guest is speaking where the session cut would remove it"},
        True,
    )
    monkeypatch.setattr(
        EditService, "held_by_checks", lambda self, ids=None: (_ for _ in ()).throw(OSError("x"))
    )
    assert service.check_proposed(ids) == ({}, False)
    assert Path(path).read_bytes() == before


@pytest.mark.parametrize("peer", [True, False], ids=["held", "clean"])
def test_the_reply_decodes_to_the_checked_payload_the_service_builds(tmp_path, monkeypatch, peer):
    path = _path(tmp_path, monkeypatch, peer=peer)
    reply = _run(path)
    assert reply["summary"] == (_HELD_SUMMARY if peer else _CLEAN_SUMMARY)
    proposal = EditService(ProjectWorkspace.open(path)).propose_tighten()
    assert reply == json.loads(to_json(proposal.to_payload()))
    (row,) = _rows(path)
    stored = row["payload"]["result"]
    assert set(stored) == _REPLY_KEYS
    assert stored == json.loads(to_json(replace(proposal, held={}, checked=False).to_payload()))


def test_a_failing_audit_returns_the_unchecked_reply(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)

    def broken(self, ids):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(EditService, "check_proposed", broken)
    reply = _run(path)
    assert "audio_check" not in reply["edits"][0]
    assert reply["summary"] == _CLEAN_SUMMARY
    assert _journal(path) == ["ProposeTighten"]


def test_the_word_probe_child_nests_under_the_tool_task(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    real = document_edit.propose_tighten_edits

    def probing(project, *args, **kwargs):
        with resolve_progress_task("word-probe", "Listening for missed words", total=2) as task:
            task.advance(2)
        return real(project, *args, **kwargs)

    monkeypatch.setattr(document_edit, "propose_tighten_edits", probing)
    rec = RecordingProgress()
    with (
        bind_progress(rec),
        progress_task("propose_edits", "Propose edits", total=1, reporter=rec),
    ):
        propose_edits(path)
    child = [e for e in rec.events if e.task_id == "word-probe"]
    assert child[0].kind == "start"
    assert child[0].total == 2
    assert any(e.kind == "update" and e.current == 2 for e in child)
    assert child[-1].kind == "end"
    assert _journal(path) == ["ProposeTighten"]


def test_a_cancel_inside_the_probe_leaves_no_row_and_no_history(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    before = Path(path).read_bytes()

    def cancelled(*args, **kwargs):
        raise CancelledProgress("stop")

    monkeypatch.setattr(document_edit, "propose_tighten_edits", cancelled)
    with pytest.raises(CancelledProgress):
        propose_edits(path)
    assert _journal(path) == []
    assert _last_command(path) is None
    assert _history(path)["total"] == 0
    assert Path(path).read_bytes() == before


def test_a_second_writer_waits_for_the_held_call_and_gets_a_later_server_seq(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    started = threading.Event()
    release = threading.Event()
    real = document_edit.propose_tighten_edits

    def slow(*args, **kwargs):
        started.set()
        assert release.wait(30)
        return real(*args, **kwargs)

    monkeypatch.setattr(document_edit, "propose_tighten_edits", slow)
    outcome: dict[str, object] = {}

    def propose() -> None:
        outcome["reply"] = _run(path)

    def meta() -> None:
        outcome["meta"] = DocumentSyncService.open(path).submit(_meta_command())

    first = threading.Thread(target=propose)
    first.start()
    assert started.wait(30)
    second = threading.Thread(target=meta)
    second.start()
    second.join(1.0)
    assert second.is_alive()
    release.set()
    first.join(60)
    second.join(60)
    assert not first.is_alive()
    assert not second.is_alive()
    assert _journal(path) == ["ProposeTighten", "SetTrackMeta"]
    seqs = [r["server_seq"] for r in _rows(path)]
    assert seqs == sorted(seqs)


def _meta_command() -> DocumentCommand:
    return DocumentCommand(
        type="SetTrackMeta",
        payload={"track_id": "host", "label": "Renamed"},
        client_id="gui",
        client_seq=1,
        role="host",
    )


def test_the_audio_check_runs_outside_the_locks(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    outcome: dict[str, object] = {}

    def spy(self, ids=None):
        def meta() -> None:
            outcome["meta"] = DocumentSyncService.open(path).submit(_meta_command())

        worker = threading.Thread(target=meta)
        worker.start()
        worker.join(30)
        outcome["finished"] = not worker.is_alive()
        return [], []

    monkeypatch.setattr(EditService, "held_by_checks", spy)
    _run(path)
    assert outcome["finished"] is True
    assert _journal(path) == ["ProposeTighten", "SetTrackMeta"]


def _post(client: TestClient, path: str, payload: dict):
    return client.post(
        f"/api/document/command?path={quote(path)}",
        json={"type": "ProposeTighten", "payload": payload, "client_id": "gui", "client_seq": 1},
    )


def test_the_command_route_maps_an_unknown_intensity_to_a_400_with_its_code(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    response = _post(TestClient(create_app()), path, {"intensity": "extreme"})
    assert response.status_code == 400
    assert response.headers["x-sharecut-error-code"] == "pipeline_config_value_invalid"
    assert _journal(path) == []


def test_the_command_route_maps_the_refine_gate_to_a_409_with_its_code(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch, gate=False)
    response = _post(TestClient(create_app()), path, {})
    assert response.status_code == 409
    assert response.headers["x-sharecut-error-code"] == "transcript_refine_required"
    assert _journal(path) == []


def test_the_command_route_maps_a_non_string_intensity_to_a_422(tmp_path, monkeypatch):
    path = _path(tmp_path, monkeypatch)
    response = _post(TestClient(create_app()), path, {"intensity": 5})
    assert response.status_code == 422
    assert "intensity" in response.text
    assert _journal(path) == []


def test_the_command_route_applies_a_proposal_and_the_shell_snapshot_carries_it(
    tmp_path, monkeypatch
):
    path = _path(tmp_path, monkeypatch)
    response = _post(TestClient(create_app()), path, {})
    assert response.status_code == 200
    assert _journal(path) == ["ProposeTighten"]
    snapshot = DocumentSyncService.open(path).document_snapshot()
    pending = snapshot["project"]["pending_edits"]
    assert [p["id"] for p in pending] == [d.id for d in _decisions(path)]
