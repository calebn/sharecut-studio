from __future__ import annotations

import pytest

from podcast_mcp.edits.source_removals import CutScopeHold, ScopeChangedAtApproval
from podcast_mcp.models import EditDecisionType, load_project, save_project
from podcast_mcp.project_store import history_index_path, history_snapshot_ids
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from source_review_helpers import _cut, _hole, _project


class RecoveryInterrupted(BaseException):
    pass


@pytest.mark.parametrize("restore_error", [None, ValueError, RecoveryInterrupted])
def test_saved_clean_first_held_later_reports_actual_restoration(
    tmp_path, monkeypatch, restore_error
):
    from podcast_mcp.history import session as session_mod
    from podcast_mcp.services.document import edit as edit_mod

    project = _project(tmp_path)
    _hole(project)
    project.edit_decisions = [_cut("held", 1.2, 1.6), _cut("valid", 3, 4)]
    ws = ProjectWorkspace.open(save_project(project))
    ws.record_snapshot("initial", force=True)
    before = ws.project.model_dump(mode="json")
    saved_before = ws.path.read_bytes()
    index = history_index_path(ws.project)
    index_before = index.read_bytes()
    snapshots_before = history_snapshot_ids(index)
    mirrors_before = {
        p.name: p.read_bytes() for p in (tmp_path / "transcripts").glob("*") if p.is_file()
    }
    original_errors = []
    approve = edit_mod.approve_edits

    def capture_error(p, ids, **kwargs):
        try:
            return approve(p, ids, **kwargs)
        except ScopeChangedAtApproval as error:
            original_errors.append(error)
            assert p.timeline.duration_sec == pytest.approx(4.98)
            assert [r.decision_ids for r in p.editorial.edit_log] == [["valid"]]
            raise

    monkeypatch.setattr(edit_mod, "approve_edits", capture_error)
    if restore_error is not None:

        def fail_restore(_project, _snapshot):
            raise restore_error("editable restoration failed")

        monkeypatch.setattr(session_mod, "apply_snapshot_to_project", fail_restore)
    with pytest.raises(ScopeChangedAtApproval) as held:
        EditService(ws).approve(["valid", "held"])
    assert held.value.ids == ("held",)
    assert held.value.held[0].reason == "source_geometry"
    assert len(original_errors) == 1
    assert ws.path.read_bytes() == saved_before
    assert index.read_bytes() == index_before
    assert history_snapshot_ids(index) == snapshots_before
    assert {
        p.name: p.read_bytes() for p in (tmp_path / "transcripts").glob("*") if p.is_file()
    } == mirrors_before
    assert ws.loaded_file_revision is None
    assert ws.project.render.model_dump(mode="json") == before["render"]
    if restore_error is None:
        assert "None of the selected edits were applied" in str(held.value)
        assert held.value.__cause__ is original_errors[0]
        assert ws.project.model_dump(mode="json") == before
    else:
        assert held.value is original_errors[0]
        assert "None of the selected edits were applied" not in str(held.value)
        assert ws.project.timeline.duration_sec == pytest.approx(4.98)
        assert [r.decision_ids for r in ws.project.editorial.edit_log] == [["valid"]]
        assert [(c.source_start, c.source_end) for c in ws.project.clips] == [
            (0, 1.4),
            (1.42, 3),
            (4, 6),
        ]
        assert [c.timeline_start for c in ws.project.clips] == pytest.approx([0, 1.4, 2.98])
    assert ws.reload().model_dump(mode="json") == before


@pytest.mark.parametrize("zero_survivors", [False, True])
def test_auto_cascading_holds_discard_trial_effects_and_keep_mute_baseline(
    tmp_path, monkeypatch, zero_survivors
):
    from podcast_mcp.edits import decisions as decisions_mod

    project = _project(tmp_path)
    mute = _cut("mute", 0.1, 0.3, reason="filler:um")
    mute.type = EditDecisionType.MUTE
    project.edit_decisions = [
        mute,
        _cut("survivor", 1, 2, reason="filler:um"),
        _cut("cascade", 3, 4, reason="filler:um"),
        _cut("first-held", 4, 5, reason="filler:um"),
    ]
    ws = ProjectWorkspace.open(save_project(project))
    actual_consume = decisions_mod.consume_source_remove
    batches = []

    def consume(p, edit, **kwargs):
        chosen = tuple((e.track_id, e.start, e.end) for e in kwargs["batch"])
        batches.append(chosen)
        assert p.clips[0].mute_regions
        assert p.editorial.edit_log[0].decision_ids == ["mute"]
        if edit.id == "first-held":
            return CutScopeHold(edit.id, (), "scope_unavailable")
        if edit.id == "cascade" and ("host", 4, 5) not in chosen:
            return CutScopeHold(edit.id, (), "peer_speech")
        if zero_survivors and edit.id == "survivor" and ("host", 3, 4) not in chosen:
            return CutScopeHold(edit.id, (), "peer_speech")
        return actual_consume(p, edit, **kwargs)

    monkeypatch.setattr(decisions_mod, "consume_source_remove", consume)
    assert EditService(ws).apply_auto() == (1 if zero_survivors else 2)
    saved = load_project(ws.path)
    assert [e.id for e in saved.edit_decisions] == (
        ["survivor", "cascade", "first-held"] if zero_survivors else ["cascade", "first-held"]
    )
    assert [r.decision_ids for r in saved.editorial.edit_log] == (
        [["mute"]] if zero_survivors else [["mute"], ["survivor"]]
    )
    assert saved.timeline.duration_sec == (6 if zero_survivors else 5)
    assert [(c.source_start, c.source_end, c.timeline_start) for c in saved.clips] == (
        [(0, 6, 0)] if zero_survivors else [(0, 1, 0), (2, 6, 1)]
    )
    assert (("host", 1, 2), ("host", 3, 4), ("host", 4, 5)) in batches
    assert (("host", 1, 2), ("host", 3, 4)) in batches
    assert (("host", 1, 2),) in batches
    assert EditService(ws).apply_auto() == 0
    assert [r.decision_ids for r in ws.project.editorial.edit_log] == (
        [["mute"]] if zero_survivors else [["mute"], ["survivor"]]
    )
