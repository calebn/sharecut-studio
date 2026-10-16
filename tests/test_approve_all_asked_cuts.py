"""Approve all applies what it can and leaves a cut-other-speech ask for only those cuts (#1537)."""

from __future__ import annotations

from pause_policy_public_helpers import workspace
from podcast_mcp.models import load_project
from podcast_mcp.services.document_sync.handlers.edits import approve_edits
from podcast_mcp.services.document_sync.handlers.history import undo_history
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


def test_a_cut_overlapping_the_asked_one_on_the_timeline_keeps_the_batch_asking(
    tmp_path, monkeypatch
):
    # Different tracks can shift source time, so closeness is judged on the timeline too.
    from podcast_mcp.edits import decisions

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

    reply = approve_edits(ws, {"ids": ["plain", asked.id], "hold_blocked": True})

    assert reply["unchanged"] is True


def test_approving_several_cuts_at_once_leaves_one_history_entry(tmp_path, monkeypatch):
    result, _asked = _with_plain_cut(tmp_path, monkeypatch)
    plain = next(e for e in result.edit_decisions if e.id == "plain")
    result.edit_decisions += [
        plain.model_copy(update={"id": "plain2", "start": 4.0, "end": 4.2}),
        plain.model_copy(update={"id": "plain3", "start": 5.0, "end": 5.2}),
    ]
    ws = workspace(result)
    approve_edits(ws, {"ids": ["plain"]})  # the first mutation also writes the baseline entry
    before = len(load_project(ws.path).history.entries)

    reply = approve_edits(ws, {"ids": ["plain2", "plain3"]})

    assert reply["count"] == 2
    assert len(load_project(ws.path).history.entries) == before + 1


def _approved_in_two_parts(tmp_path, monkeypatch, *, continues: bool = True):
    """Approve all, then Cut anyway: the two steps of one pass. Returns each part's history head."""
    result, asked = _with_plain_cut(tmp_path, monkeypatch)
    ws = workspace(result)
    first = approve_edits(ws, {"ids": ["plain", asked.id], "hold_blocked": True})
    first_head = load_project(ws.path).history.head_id()
    approve_edits(
        ws,
        {
            "ids": first["confirm_ids"],
            "hold_blocked": True,
            "confirm_cut_speech": True,
            **({"continues_head_id": first_head} if continues else {}),
        },
    )
    return ws, asked, load_project(ws.path).history.head_id()


def test_one_undo_takes_back_the_whole_pass(tmp_path, monkeypatch):
    ws, asked, second_head = _approved_in_two_parts(tmp_path, monkeypatch)
    assert load_project(ws.path).edit_decisions == []

    undo_history(ws, {"expected_head_id": second_head})

    assert {e.id for e in load_project(ws.path).edit_decisions} == {"plain", asked.id}


def test_without_the_pass_marker_undo_takes_back_only_the_cut_anyway_step(tmp_path, monkeypatch):
    ws, asked, second_head = _approved_in_two_parts(tmp_path, monkeypatch, continues=False)

    undo_history(ws, {"expected_head_id": second_head})

    assert [e.id for e in load_project(ws.path).edit_decisions] == [asked.id]


def test_a_marker_naming_an_entry_another_edit_follows_undoes_just_one_step(tmp_path, monkeypatch):
    # The first part is no longer directly behind this one, so the pass is not intact.
    result, asked = _with_plain_cut(tmp_path, monkeypatch)
    ws = workspace(result)
    approve_edits(ws, {"ids": ["plain"]})
    first_head = load_project(ws.path).history.head_id()
    ws.mutate(
        "before later edit",
        "after later edit",
        lambda p: p.edit_decisions.append(asked.model_copy(update={"id": "later"})),
        operation="later_edit",
    )
    approve_edits(
        ws, {"ids": ["later"], "confirm_cut_speech": True, "continues_head_id": first_head}
    )
    head = load_project(ws.path).history.head_id()

    undo_history(ws, {"expected_head_id": head})

    assert {e.id for e in load_project(ws.path).edit_decisions} == {asked.id, "later"}
