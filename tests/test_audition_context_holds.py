"""`play context` says why a pending edit in the window would be held (#3843 item 5)."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.audition_context import build_audition_context
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.models import save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService, PlayService
from source_review_helpers import _cut, _hole, _project

pytestmark = pytest.mark.refine_gate


def _review(edit_id, start, end):
    return _cut(edit_id, start, end, review_required=True)


def _open(tmp_path, decisions):
    project = _project(tmp_path)
    _hole(project)
    project.edit_decisions = decisions
    REFINE_GATE.mark_done(project, notes="Known synthetic transcript fixture; no real-project test")
    return ProjectWorkspace.open(save_project(project))


def _pending(ctx):
    return {row["id"]: row for row in ctx["edits"]["pending"]}


def test_a_held_pending_edit_carries_the_reason_edit_held_gives(tmp_path):
    ws = _open(tmp_path, [_review("held", 1.2, 1.6), _review("ok", 4, 4.4)])
    held, asked = EditService(ws).held_by_checks()
    assert not asked
    edit_held = {h.edit_id: h.reason for h in held}
    assert set(edit_held) == {"held"}

    rows = _pending(PlayService(ws).audition_context(0.0, 5.9, include_dsp=False))

    assert rows["held"]["audio_check"] == {"status": "held", "reason": edit_held["held"]}
    assert rows["ok"]["audio_check"] == {"status": "clean"}


def test_only_the_window_rows_get_a_check_and_the_check_covers_approve_all(tmp_path, monkeypatch):
    ws = _open(tmp_path, [_review("held", 1.2, 1.6), _review("ok", 4, 4.4), _cut("auto", 5.5, 5.7)])
    asked_for: list[list[str]] = []
    real = EditService.held_by_checks

    def spy(self, ids=None):
        asked_for.append(list(ids or []))
        return real(self, ids)

    monkeypatch.setattr(EditService, "held_by_checks", spy)

    rows = _pending(PlayService(ws).audition_context(3.5, 5.0, include_dsp=False))

    assert set(rows) == {"ok"}
    assert rows["ok"]["audio_check"] == {"status": "clean"}
    # The window's edit first, then what Approve all runs on; an edit that needs no
    # review and sits outside the window is not checked.
    assert asked_for[0] == ["ok", "held"]
    assert all("auto" not in ids for ids in asked_for)


def test_a_window_with_no_pending_edit_runs_no_check(tmp_path, monkeypatch):
    ws = _open(tmp_path, [_review("ok", 4, 4.4)])
    monkeypatch.setattr(
        EditService, "held_by_checks", lambda *_a, **_k: pytest.fail("no pending edit to check")
    )
    ctx = PlayService(ws).audition_context(0.0, 1.0, include_dsp=False)
    assert ctx["edits"]["pending"] == []


def test_an_unreadable_check_leaves_the_rows_without_a_claim(tmp_path, monkeypatch):
    ws = _open(tmp_path, [_review("held", 1.2, 1.6)])

    def boom(self, ids=None):
        raise OSError("audio unreadable")

    monkeypatch.setattr(EditService, "held_by_checks", boom)

    rows = _pending(PlayService(ws).audition_context(0.0, 5.9, include_dsp=False))

    assert "audio_check" not in rows["held"]
    assert rows["held"]["review_required"] is True


def test_the_builder_itself_adds_no_audio_check(tmp_path):
    # Guest share context calls the builder directly; the hold check stays host-only.
    ws = _open(tmp_path, [_review("held", 1.2, 1.6)])
    ctx = build_audition_context(
        ws.project, 0.0, 5.9, include_dsp=False, defaults=ws.effective_config()
    )
    assert "audio_check" not in _pending(ctx)["held"]


def test_a_cut_beside_a_held_one_outside_the_window_is_not_called_clean(tmp_path):
    # Approve all holds a cut that sits right beside a held one; the window may hold only
    # the neighbour, so the check runs over what Approve all would run on, not the window.
    ws = _open(
        tmp_path, [_review("held", 1.2, 1.6), _review("near", 1.8, 2.0), _review("ok", 4, 4.4)]
    )
    held, _asked = EditService(ws).held_by_checks()
    edit_held = {h.edit_id: h.reason for h in held}

    whole = _pending(PlayService(ws).audition_context(0.0, 5.9, include_dsp=False))
    narrow = _pending(PlayService(ws).audition_context(1.7, 2.1, include_dsp=False))

    assert set(narrow) == {"near"}
    assert "near" in edit_held
    assert whole["near"]["audio_check"] == {"status": "held", "reason": edit_held["near"]}
    assert narrow["near"]["audio_check"] == whole["near"]["audio_check"]
