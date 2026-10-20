from __future__ import annotations

import pytest

from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document_sync.handlers import edits as handlers
from source_review_helpers import _cut, _hole, _project

pytestmark = pytest.mark.refine_gate


def _open_with_one_held_cut(tmp_path):
    project = _project(tmp_path)
    _hole(project)
    project.edit_decisions = [_cut("ok-a", 3, 3.4), _cut("held", 1.2, 1.6), _cut("ok-b", 4, 4.4)]
    REFINE_GATE.mark_done(project, notes="Known synthetic transcript fixture; no real-project test")
    return ProjectWorkspace.open(save_project(project))


def test_a_held_cut_still_refuses_the_whole_batch_by_default(tmp_path):
    ws = _open_with_one_held_cut(tmp_path)
    before = ws.path.read_bytes()
    with pytest.raises(ScopeChangedAtApproval):
        EditService(ws).approve(["ok-a", "held", "ok-b"])
    assert ws.path.read_bytes() == before


def test_approve_all_applies_the_approvable_cuts_and_leaves_the_held_one_pending(tmp_path):
    ws = _open_with_one_held_cut(tmp_path)

    result = handlers.approve_edits(ws, {"ids": ["ok-a", "held", "ok-b"], "hold_blocked": True})

    assert result["count"] == 2
    assert [h["id"] for h in result["held"]] == ["held"]
    assert "Host's cut at" in result["held"][0]["label"]
    assert "continuous placement" in result["held"][0]["reason"]
    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == ["held"]
    assert not saved.edit_decisions[0].applied


def test_a_hold_far_from_the_applied_cuts_does_not_rerun_them(tmp_path, monkeypatch):
    # ok-a and ok-b are applied before "held" is found; neither sits beside it, so the
    # pass must not start over (one run per cut, not one per hold) (#1741).
    from podcast_mcp.edits import cut_application

    ws = _open_with_one_held_cut(tmp_path)
    real = cut_application._apply_source_remove
    runs: list[str] = []

    def spy(project, edit, **kwargs):
        runs.append(edit.id)
        return real(project, edit, **kwargs)

    monkeypatch.setattr(cut_application, "_apply_source_remove", spy)

    assert EditService(ws).approve(["ok-a", "held", "ok-b"], held_out=[]) == 2
    assert sorted(runs) == ["held", "ok-a", "ok-b"]


def test_held_labels_name_the_cut_where_the_list_shows_it(tmp_path):
    ws = _open_with_one_held_cut(tmp_path)
    held = []
    EditService(ws).approve(["held", "ok-a", "ok-b"], held_out=held)
    assert [h.edit_id for h in held] == ["held"]
    assert held[0].label == "Host's cut at 0:01.2"


def test_a_cut_beside_a_held_one_waits_with_it(tmp_path):
    # ok-near sits next to the held cut, so it may have cleared speech on the
    # assumption that the held one removes it; it waits too instead of guessing.
    project = _project(tmp_path)
    _hole(project)
    project.edit_decisions = [
        _cut("ok-near", 1.7, 2.0),
        _cut("held", 1.2, 1.6),
        _cut("far", 4, 4.4),
    ]
    REFINE_GATE.mark_done(project, notes="Known synthetic transcript fixture; no real-project test")
    ws = ProjectWorkspace.open(save_project(project))
    held: list = []

    count = EditService(ws).approve(["ok-near", "held", "far"], held_out=held)

    assert count == 1
    assert {h.edit_id for h in held} == {"ok-near", "held"}
    assert {e.id for e in load_project(ws.path).edit_decisions} == {"ok-near", "held"}


def test_explicit_ids_apply_the_clean_cuts_and_keep_the_held_one_pending(tmp_path):
    from typer.testing import CliRunner

    from podcast_mcp.cli.main import app

    ws = _open_with_one_held_cut(tmp_path)

    done = CliRunner().invoke(
        app, ["edit", "approve", "--project", str(ws.path), "--ids", "ok-a,held,ok-b"]
    )

    assert done.exit_code == 0, done.output
    assert "Approved 2 edit(s)." in done.output
    assert "Held held:" in done.output
    assert [e.id for e in load_project(ws.path).edit_decisions] == ["held"]


def test_a_proposal_whose_audio_was_cut_away_is_held_not_a_failure(tmp_path, monkeypatch):
    from podcast_mcp.edits import cut_application

    ws = _open_with_one_held_cut(tmp_path)
    monkeypatch.setattr(cut_application, "unplayed_pending_ids", lambda *_a, **_k: ["ok-a"])
    held: list = []

    assert EditService(ws).approve(["ok-a", "ok-b"], held_out=held) == 1

    assert [(h.edit_id, "cut away" in h.reason) for h in held] == [("ok-a", True)]
    assert "ok-a" in {e.id for e in load_project(ws.path).edit_decisions}


def test_many_held_edits_are_summed_up_by_reason(tmp_path, capsys):
    from podcast_mcp.cli.edit import _echo_held
    from podcast_mcp.edits.decisions import HeldEdit

    held = [
        HeldEdit(f"e{i}", f"cut {i}", "voiced edge" if i % 3 else "word edge") for i in range(20)
    ]

    _echo_held(held, [])

    err = capsys.readouterr().err
    assert "Held 20 edit(s):" in err
    assert "13 x voiced edge" in err
    assert "7 x word edge" in err
    assert "podcast edit held" in err
    assert "e5" not in err
