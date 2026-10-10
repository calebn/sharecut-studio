from __future__ import annotations

import pytest

from podcast_mcp.edits.transcript_refine_status import mark_refine_done
from podcast_mcp.history.manager import HistoryManager, snapshot_from_project
from podcast_mcp.models import EditDecisionType, load_project, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService, HistoryService
from source_review_helpers import _cut, _hole, _project

pytestmark = pytest.mark.refine_gate


def test_remove_restore_refuses_before_recording_any_history(tmp_path, monkeypatch):
    project = _project(tmp_path)
    project.edit_decisions = [_cut("cut", reason="filler:um")]
    mark_refine_done(project, notes="Known synthetic fixture; no real-project acceptance")
    ws = ProjectWorkspace.open(save_project(project))
    assert EditService(ws).approve(["cut"]) == 1
    before = ws.project.model_dump(mode="json")
    disk = ws.path.read_bytes()

    def history_must_not_start(*args, **kwargs):
        raise AssertionError("Restore attempted to record history before refusing")

    monkeypatch.setattr(HistoryManager, "record", history_must_not_start)
    with pytest.raises(ValueError) as refused:
        EditService(ws).revert_applied(ws.project.editorial.edit_log[0].id)
    assert getattr(refused.value, "code", None) == "local_restore_requires_history"
    assert str(refused.value) == (
        "This edit cannot be restored individually. Use History Undo to restore the whole action. "
        "History Undo also undoes the other edits in that action. "
        "You may need to undo later actions first."
    )
    assert ws.project.model_dump(mode="json") == before
    assert ws.path.read_bytes() == disk
    assert [
        (c.source_start, c.source_end, c.timeline_start) for c in load_project(ws.path).clips
    ] == [(0, 1, 0), (2, 6, 1)]


def test_manual_group_cannot_connect_across_an_intervening_review_barrier(tmp_path):
    project = _project(tmp_path)
    project.edit_decisions = [
        _cut("covering", 1, 4, review_required=True, crossfade_ms=17),
        _cut("review-barrier", 2, 2.1, reason="filler:acoustic", review_required=True),
    ]
    mark_refine_done(project, notes="Known synthetic fixture; no real-project acceptance")
    ws = ProjectWorkspace.open(save_project(project))
    original = [row.model_dump_json() for row in ws.project.edit_decisions]
    EditService(ws).cut_time_range("host", 3, 3.4, reason="nl:range", use_inaudible_opt=False)
    saved = load_project(ws.path)
    assert [row.model_dump_json() for row in saved.edit_decisions[:2]] == original
    assert [(row.start, row.end, row.reason) for row in saved.edit_decisions] == [
        (1, 4, "nl:range"),
        (2, 2.1, "filler:acoustic"),
        (3, 3.4, "nl:range"),
    ]
    assert saved.editorial.edit_log == []
    assert [(c.id, c.source_start, c.source_end, c.timeline_start) for c in saved.clips] == [
        ("host", 0, 6, 0)
    ]


def test_all_held_auto_apply_does_not_start_history(tmp_path, monkeypatch):
    project = _project(tmp_path)
    clip = project.clips[0]
    project.clips = [
        clip.model_copy(update={"source_end": 1}),
        clip.model_copy(update={"id": "tail", "source_start": 2, "timeline_start": 2}),
    ]
    project.edit_decisions = [
        _cut("source-hole", 0.5, 2.5, reason="filler:um", review_required=False)
    ]
    mark_refine_done(project, notes="Known synthetic fixture; no real-project acceptance")
    ws = ProjectWorkspace.open(save_project(project))
    before = ws.project.model_dump(mode="json")
    disk = ws.path.read_bytes()

    def history_must_not_start(*args, **kwargs):
        raise AssertionError("All-held auto application attempted to record history")

    monkeypatch.setattr(HistoryManager, "record", history_must_not_start)
    assert EditService(ws).apply_auto() == 0
    assert ws.project.model_dump(mode="json") == before
    assert ws.path.read_bytes() == disk
    assert [row.id for row in load_project(ws.path).edit_decisions] == ["source-hole"]
    assert not (tmp_path / "history" / "index.json").exists()


@pytest.mark.parametrize("edit_type", [EditDecisionType.REMOVE, EditDecisionType.MUTE])
def test_auto_apply_keeps_held_cut_and_undo_restores_the_positive_action(tmp_path, edit_type):
    project = _project(tmp_path)
    _hole(project)
    valid = _cut("valid", 3, 4, reason="filler:um", review_required=False)
    valid.type = edit_type
    project.edit_decisions = [
        _cut("held", 1.2, 1.6, reason="filler:um", review_required=False),
        valid,
    ]
    mark_refine_done(project, notes="Known synthetic fixture; no real-project acceptance")
    ws = ProjectWorkspace.open(save_project(project))
    original = snapshot_from_project(ws.project).model_dump(mode="json")
    original_clips = [clip.model_dump(mode="json") for clip in ws.project.clips]

    assert EditService(ws).apply_auto() == 1
    saved = load_project(ws.path)
    assert [row.id for row in saved.edit_decisions] == ["held"]
    assert [row.decision_ids for row in saved.editorial.edit_log] == [["valid"]]
    assert [entry.label for entry in saved.history.entries] == [
        "before apply auto edits",
        "after apply auto edits",
    ]
    assert saved.render.reconciliation_stale is True
    if edit_type == EditDecisionType.MUTE:
        assert [(c.source_start, c.source_end, c.timeline_start) for c in saved.clips] == [
            (0, 1.4, 0),
            (1.42, 6, 1.4),
        ]
        assert saved.clips[1].mute_regions
        assert saved.timeline.duration_sec == pytest.approx(5.98)
    else:
        assert [(c.source_start, c.source_end) for c in saved.clips] == [
            (0, 1.4),
            (1.42, 3),
            (4, 6),
        ]
        assert [c.timeline_start for c in saved.clips] == pytest.approx([0, 1.4, 2.98])
        assert saved.timeline.duration_sec == pytest.approx(4.98)
    history = HistoryService(ws)
    status = history.status()
    assert status["can_undo"] is True
    history.undo(expected_head_id=status["head_id"])
    assert snapshot_from_project(ws.project).model_dump(mode="json") == original
    assert [clip.model_dump(mode="json") for clip in ws.project.clips] == original_clips
