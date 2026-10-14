"""Approve all applies what it can and leaves a cut-other-speech ask for only those cuts (#1537)."""

from __future__ import annotations

from pause_policy_public_helpers import workspace
from podcast_mcp.models import load_project
from podcast_mcp.services.document_sync.handlers.edits import approve_edits
from test_approve_guard_blocked_ripple import _blocked_filler


def _with_plain_cut(tmp_path, monkeypatch):
    result, asked = _blocked_filler(tmp_path, monkeypatch)
    plain = asked.model_copy(
        update={
            "id": "plain",
            "start": 3.0,
            "end": 3.3,
            "reason": "nl:range",
            "cut_speech": None,
            "review_required": False,
        }
    )
    result.edit_decisions.append(plain)
    return result, asked


def test_approve_all_applies_the_plain_cut_and_asks_only_for_the_speech_cut(tmp_path, monkeypatch):
    result, asked = _with_plain_cut(tmp_path, monkeypatch)
    ws = workspace(result)

    reply = approve_edits(ws, {"ids": ["plain", asked.id], "hold_blocked": True})

    assert reply["count"] == 1
    assert reply["confirm_ids"] == [asked.id]
    assert reply["needs_confirmation"]["reason"] == "cuts_other_speech"
    assert [e.id for e in load_project(ws.path).edit_decisions] == [asked.id]


def test_cut_anyway_then_runs_only_the_asked_cut(tmp_path, monkeypatch):
    result, asked = _with_plain_cut(tmp_path, monkeypatch)
    ws = workspace(result)
    approve_edits(ws, {"ids": ["plain", asked.id], "hold_blocked": True})

    reply = approve_edits(ws, {"ids": [asked.id], "hold_blocked": True, "confirm_cut_speech": True})

    assert reply["count"] == 1
    assert "needs_confirmation" not in reply
    assert load_project(ws.path).edit_decisions == []


def test_a_single_approve_still_asks_before_anything_applies(tmp_path, monkeypatch):
    result, asked = _with_plain_cut(tmp_path, monkeypatch)
    ws = workspace(result)
    before = ws.project.model_dump(mode="json")

    reply = approve_edits(ws, {"ids": ["plain", asked.id]})

    assert reply["unchanged"] is True
    assert ws.project.model_dump(mode="json") == before


def test_a_cut_beside_the_asked_one_keeps_the_whole_batch_asking(tmp_path, monkeypatch):
    result, asked = _with_plain_cut(tmp_path, monkeypatch)
    near = next(e for e in result.edit_decisions if e.id == "plain")
    near.start, near.end = asked.end + 0.1, asked.end + 0.3
    ws = workspace(result)
    before = ws.project.model_dump(mode="json")

    reply = approve_edits(ws, {"ids": ["plain", asked.id], "hold_blocked": True})

    assert reply["unchanged"] is True
    assert "count" not in reply
    assert ws.project.model_dump(mode="json") == before
