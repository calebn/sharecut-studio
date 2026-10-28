"""apply_edits journals one ApplyAutoEdits command per call (#1847)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from pause_policy_public_helpers import configure, defaults, pause
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.mcp.tools import edits as mcp_edits
from podcast_mcp.mcp.tools.history import history_undo
from podcast_mcp.models import load_project
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.util.coded_error import CodedError
from test_apply_edits_tool_pin import (
    _filler,
    _held_path,
    _history,
    _normalised,
    _path,
    _pending_ids,
)


def _rows(path: str) -> list[dict]:
    return DocumentSyncService.open(path).store.commands_after(0)


def _types(path: str) -> list[str]:
    return [row["type"] for row in _rows(path)]


@pytest.fixture(autouse=True)
def _config(monkeypatch):
    configure(monkeypatch, defaults())


def test_applied_edits_journal_one_apply_auto_edits_command(tmp_path):
    path = _path(tmp_path, [pause("pause", start=0.3, end=2.0), _filler()])
    reply = json.loads(mcp_edits.apply_edits(path))
    rows = _rows(path)
    assert [row["type"] for row in rows] == ["ApplyAutoEdits"]
    assert set(rows[0]["payload"]) == {"result"}
    assert rows[0]["payload"]["result"]["applied_count"] == reply["applied_count"] == 2


def test_applied_edits_are_still_one_history_step(tmp_path):
    path = _path(tmp_path, [pause("pause", start=0.3, end=2.0), _filler()])
    before = _normalised(path)
    total = _history(path)["total"]
    mcp_edits.apply_edits(path)
    status = _history(path)
    assert status["total"] == total + 2
    assert status["current_label"] == "after apply auto edits"
    history_undo(path)
    assert _normalised(path) == before


def test_nothing_to_apply_journals_one_row_and_changes_nothing(tmp_path):
    path = _path(tmp_path, [])
    before_bytes = Path(path).read_bytes()
    before_history = _history(path)
    reply = json.loads(mcp_edits.apply_edits(path))
    assert reply == {"operation": "apply_auto_edits", "applied_count": 0}
    assert _types(path) == ["ApplyAutoEdits"]
    assert _history(path) == before_history
    assert Path(path).read_bytes() == before_bytes


def test_second_call_after_applying_journals_a_second_row_with_no_history_step(tmp_path):
    path = _path(tmp_path, [_filler()])
    mcp_edits.apply_edits(path)
    before_history = _history(path)
    reply = json.loads(mcp_edits.apply_edits(path))
    assert reply["applied_count"] == 0
    assert _types(path) == ["ApplyAutoEdits", "ApplyAutoEdits"]
    assert _history(path) == before_history


@pytest.mark.refine_gate
def test_unrefined_transcript_keeps_transcript_refine_required_via_the_tool(tmp_path):
    path = _path(tmp_path, [_filler()], refined=False)
    assert not REFINE_GATE.is_clear(load_project(Path(path)))
    before_bytes = Path(path).read_bytes()
    with pytest.raises(CodedError) as raised:
        mcp_edits.apply_edits(path)
    assert raised.value.code == "transcript_refine_required"
    assert _rows(path) == []
    assert Path(path).read_bytes() == before_bytes
    assert _history(path)["total"] == 0


def test_a_held_cut_stays_pending_without_error(tmp_path, monkeypatch):
    configure(monkeypatch, defaults(acoustic=True))
    path = _held_path(tmp_path, [pause("held", start=0.2, end=4.7)])
    reply = json.loads(mcp_edits.apply_edits(path))
    assert reply == {"operation": "apply_auto_edits", "applied_count": 0}
    assert _pending_ids(path) == ["held"]
    assert _types(path) == ["ApplyAutoEdits"]


def test_reply_is_exactly_operation_and_applied_count(tmp_path):
    path = _path(tmp_path, [_filler()])
    assert set(json.loads(mcp_edits.apply_edits(path))) == {"operation", "applied_count"}
