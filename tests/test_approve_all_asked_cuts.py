"""Approve all applies what it can and leaves a cut-other-speech ask for only those cuts (#1537)."""

from __future__ import annotations

import pytest

from pause_policy_public_helpers import workspace
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.transcript_cuts import append_remove_decision
from podcast_mcp.models import CutIntent, load_project
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document_sync.handlers.edits import approve_edits
from test_approve_guard_blocked_ripple import _blocked_filler


def _with_plain_cut(tmp_path, monkeypatch):
    result, asked = _blocked_filler(tmp_path, monkeypatch)
    append_remove_decision(
        result,
        "host",
        3,
        3.3,
        decision_id="plain",
        reason="nl:range",
        review_required=False,
        defaults=load_defaults(),
    )
    return result, asked


def test_approve_all_applies_the_plain_cut_and_asks_only_for_the_speech_cut(tmp_path, monkeypatch):
    result, asked = _with_plain_cut(tmp_path, monkeypatch)
    ws = workspace(result)

    reply = approve_edits(ws, {"ids": ["plain", asked.id], "hold_blocked": True})

    assert reply["count"] == 1
    assert [row["id"] for row in reply["held"]] == [asked.id]
    assert "Guest is speaking" in reply["held"][0]["reason"]
    assert [e.id for e in load_project(ws.path).edit_decisions] == [asked.id]


def test_cut_anyway_then_runs_only_the_asked_cut(tmp_path, monkeypatch):
    result, asked = _with_plain_cut(tmp_path, monkeypatch)
    ws = workspace(result)
    approve_edits(ws, {"ids": ["plain", asked.id], "hold_blocked": True})

    assert EditService(ws).approve([asked.id], application_intent=CutIntent.HUMAN_BOUNDARIES) == 1
    assert load_project(ws.path).edit_decisions == []


def test_a_single_approve_still_asks_before_anything_applies(tmp_path, monkeypatch):
    result, asked = _with_plain_cut(tmp_path, monkeypatch)
    ws = workspace(result)
    before = ws.project.model_dump(mode="json")

    with pytest.raises(ScopeChangedAtApproval):
        approve_edits(ws, {"ids": ["plain", asked.id]})
    assert ws.project.model_dump(mode="json") == before


def _waits_with_the_asked_one(ws, asked):
    """A cut beside a left-pending one may lean on it, so it waits; nothing applies on a guess."""
    reply = approve_edits(ws, {"ids": ["plain", asked.id], "hold_blocked": True})

    assert reply["count"] == 0
    assert {row["id"] for row in reply["held"]} == {"plain", asked.id}
    assert {e.id for e in load_project(ws.path).edit_decisions} == {"plain", asked.id}


def test_a_cut_beside_the_asked_one_waits_with_it(tmp_path, monkeypatch):
    result, asked = _with_plain_cut(tmp_path, monkeypatch)
    near = next(e for e in result.edit_decisions if e.id == "plain")
    result.edit_decisions.remove(near)
    append_remove_decision(
        result,
        "host",
        asked.end + 0.1,
        asked.end + 0.3,
        decision_id="plain",
        reason="nl:range",
        defaults=load_defaults(),
    )
    ws = workspace(result)

    _waits_with_the_asked_one(ws, asked)


def test_a_cut_overlapping_the_asked_one_on_the_timeline_waits_with_it(tmp_path, monkeypatch):
    # Different tracks can shift source time, so closeness is judged on the timeline too.
    from podcast_mcp.edits import cut_application as decisions

    result, asked = _with_plain_cut(tmp_path, monkeypatch)
    monkeypatch.setattr(decisions, "_near", lambda *_a, **_k: False)
    real = decisions.edit_timeline_range
    monkeypatch.setattr(
        decisions,
        "edit_timeline_range",
        lambda project, edit, *a, **k: (
            (1.0, 1.4) if edit.id == "plain" else real(project, edit, *a, **k)
        ),
    )
    ws = workspace(result)

    _waits_with_the_asked_one(ws, asked)


def test_approving_several_cuts_at_once_leaves_one_history_entry(tmp_path, monkeypatch):
    result, _asked = _with_plain_cut(tmp_path, monkeypatch)
    for edit_id, start, end in (("plain2", 4.0, 4.2), ("plain3", 5.4, 5.7)):
        append_remove_decision(
            result,
            "host",
            start,
            end,
            decision_id=edit_id,
            reason="nl:range",
            defaults=load_defaults(),
        )
    ws = workspace(result)
    approve_edits(ws, {"ids": ["plain"]})  # the first mutation also writes the baseline entry
    before = len(load_project(ws.path).history.entries)

    reply = approve_edits(ws, {"ids": ["plain2", "plain3"]})

    assert reply["count"] == 2
    assert len(load_project(ws.path).history.entries) == before + 1
