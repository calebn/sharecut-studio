"""Approve all applies what it can and leaves a cut-other-speech ask for only those cuts (#1537)."""

from __future__ import annotations

from pause_policy_public_helpers import workspace
from podcast_mcp.models import load_project
from podcast_mcp.services.document_sync.handlers.edits import approve_edits
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.document_sync.handlers.history import redo_history, undo_history
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


def _head(ws) -> str:
    return load_project(ws.path).history.head_id()


def _decisions(ws) -> set[str]:
    return {e.id for e in load_project(ws.path).edit_decisions}


def _two_part_pass(tmp_path, monkeypatch, *, between=None, marker="first"):
    """Approve all, then Cut anyway. ``between`` runs after part one; ``marker`` is the
    ``continues_head_id`` sent ("first" = the part-one head, None = none, else literal)."""
    result, asked = _with_plain_cut(tmp_path, monkeypatch)
    plain = next(e for e in result.edit_decisions if e.id == "plain")
    result.edit_decisions += [
        plain.model_copy(update={"id": "other", "start": 4.0, "end": 4.2}),
        plain.model_copy(update={"id": "later", "start": 5.5, "end": 5.6}),
    ]
    ws = workspace(result)
    first = approve_edits(ws, {"ids": ["plain", asked.id], "hold_blocked": True})
    first_head = _head(ws)
    if between:
        between(ws)
    sent = first_head if marker == "first" else marker
    approve_edits(
        ws,
        {
            "ids": first["confirm_ids"],
            "hold_blocked": True,
            "confirm_cut_speech": True,
            **({"continues_head_id": sent} if sent else {}),
        },
    )
    return ws, asked, _head(ws)


def _preview(ws):
    ws.mutate(
        "before render preview",
        "after render preview",
        lambda p: p.edit_decisions.append(
            next(e for e in p.edit_decisions if e.id == "later").model_copy(update={"id": "mark"})
        ),
        operation="render_preview",
    )


def test_one_undo_takes_back_the_whole_pass(tmp_path, monkeypatch):
    ws, asked, head = _two_part_pass(tmp_path, monkeypatch)
    assert _decisions(ws) == {"other", "later"}

    undo_history(ws, {"expected_head_id": head})

    assert _decisions(ws) == {"plain", asked.id, "other", "later"}


def test_one_redo_brings_the_whole_pass_back(tmp_path, monkeypatch):
    ws, _asked, head = _two_part_pass(tmp_path, monkeypatch)
    undo_history(ws, {"expected_head_id": head})

    redo_history(ws, {"expected_head_id": _head(ws)})

    assert _decisions(ws) == {"other", "later"}
    assert _head(ws) == head


def test_the_first_parts_own_preview_render_stays_one_pass(tmp_path, monkeypatch):
    ws, asked, head = _two_part_pass(tmp_path, monkeypatch, between=_preview)

    undo_history(ws, {"expected_head_id": head})

    # The whole pass is gone, back to before part one (the preview's marker with it).
    assert _decisions(ws) == {"plain", asked.id, "other", "later"}


def test_without_the_pass_marker_undo_takes_back_only_the_cut_anyway_step(tmp_path, monkeypatch):
    ws, asked, head = _two_part_pass(tmp_path, monkeypatch, marker=None)

    undo_history(ws, {"expected_head_id": head})

    assert _decisions(ws) == {asked.id, "other", "later"}


def test_another_approval_between_the_parts_is_not_undone_with_the_pass(tmp_path, monkeypatch):
    ws, asked, head = _two_part_pass(
        tmp_path, monkeypatch, between=lambda w: approve_edits(w, {"ids": ["other"]})
    )

    undo_history(ws, {"expected_head_id": head})

    assert _decisions(ws) == {asked.id, "later"}


def test_a_manual_snapshot_between_the_parts_is_not_undone_with_the_pass(tmp_path, monkeypatch):
    ws, asked, head = _two_part_pass(
        tmp_path, monkeypatch, between=lambda w: HistoryService(w).record("manual")
    )

    undo_history(ws, {"expected_head_id": head})

    assert _decisions(ws) == {asked.id, "other", "later"}


def test_a_stale_marker_naming_an_older_approval_undoes_one_step(tmp_path, monkeypatch):
    result, asked = _with_plain_cut(tmp_path, monkeypatch)
    plain = next(e for e in result.edit_decisions if e.id == "plain")
    result.edit_decisions.append(plain.model_copy(update={"id": "other", "start": 4.0, "end": 4.2}))
    ws = workspace(result)
    approve_edits(ws, {"ids": ["other"]})
    older = _head(ws)
    first = approve_edits(ws, {"ids": ["plain", asked.id], "hold_blocked": True})
    approve_edits(
        ws,
        {
            "ids": first["confirm_ids"],
            "hold_blocked": True,
            "confirm_cut_speech": True,
            "continues_head_id": older,
        },
    )

    undo_history(ws, {"expected_head_id": _head(ws)})

    assert _decisions(ws) == {asked.id}
