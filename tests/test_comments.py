from __future__ import annotations

import pytest

from podcast_mcp.edits.comments import (
    COMMENT_BODY_MAX,
    add_comment,
    add_reply,
    delete_comment,
    list_comments,
    resolve_comment,
    set_action_item_done,
)
from podcast_mcp.models import MediaAsset, Track, TrackRole, load_project, save_project
from podcast_mcp.models.project_format import (
    apply_editable_snapshot,
    snapshot_editable_state,
)
from podcast_mcp.services import CommentService, ProjectWorkspace


def _with_host(proj, sample_wav, tmp_workspace):
    (tmp_workspace / "raw").mkdir(exist_ok=True)
    (tmp_workspace / "raw" / "host.wav").write_bytes(sample_wav.read_bytes())
    proj.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav"),
        )
    )
    return proj


def test_add_list_resolve_action(minimal_project, sample_wav, tmp_workspace):
    proj = _with_host(load_project(minimal_project), sample_wav, tmp_workspace)
    c = add_comment(
        proj,
        body="Trim the intro",
        author="caleb",
        timeline_start=12.5,
        timeline_end=20.0,
        track_ids=["host"],
        action_texts=["Cut filler", "Check levels"],
    )
    assert c.id
    assert c.timeline_end == 20.0
    assert c.track_ids == ["host"]
    assert len(c.action_items) == 2
    assert not c.resolved

    open_only = list_comments(proj, include_resolved=False)
    assert len(open_only) == 1

    item = set_action_item_done(proj, c.id, c.action_items[0].id, done=True, by="agent")
    assert item.done
    assert item.completed_by == "agent"
    assert item.completed_at

    resolved = resolve_comment(proj, c.id, by="caleb")
    assert resolved.resolved
    assert resolved.resolved_by == "caleb"

    assert list_comments(proj, include_resolved=False) == []
    assert delete_comment(proj, c.id)


def test_instant_comment_normalizes_equal_end(minimal_project):
    proj = load_project(minimal_project)
    c = add_comment(
        proj,
        body="point",
        author="a",
        timeline_start=5.0,
        timeline_end=5.0,
    )
    assert c.timeline_end is None


def test_unknown_track_raises(minimal_project):
    proj = load_project(minimal_project)
    with pytest.raises(ValueError, match="unknown track"):
        add_comment(
            proj,
            body="x",
            author="a",
            timeline_start=1.0,
            track_ids=["nope"],
        )


def test_ask_thread_unique_per_pending_edit(minimal_project, sample_wav, tmp_workspace):
    from podcast_mcp.models import EditDecision, EditDecisionType

    proj = _with_host(load_project(minimal_project), sample_wav, tmp_workspace)
    proj.edit_decisions.append(
        EditDecision(
            id="ed1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=2.0,
            applied=False,
            review_required=True,
        )
    )
    root = add_comment(
        proj,
        body="Why this cut?",
        author="host",
        timeline_start=1.0,
        timeline_end=2.0,
        track_ids=["host"],
        edit_decision_id="ed1",
    )
    assert root.edit_decision_id == "ed1"
    with pytest.raises(ValueError, match="already has a comment thread"):
        add_comment(
            proj,
            body="second root",
            author="guest",
            timeline_start=1.0,
            edit_decision_id="ed1",
        )
    with pytest.raises(ValueError, match="no pending edit decision"):
        add_comment(
            proj,
            body="orphan",
            author="a",
            timeline_start=0.0,
            edit_decision_id="missing",
        )


def test_comment_service_mutate_and_snapshot(minimal_project, sample_wav, tmp_workspace):
    proj = _with_host(load_project(minimal_project), sample_wav, tmp_workspace)
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    svc = CommentService(ws)
    comment = svc.add(
        body="Feedback",
        author="reviewer",
        timeline_start=3.0,
        action_texts=["Fix breath"],
    )
    assert comment["author"] == "reviewer"
    snap = snapshot_editable_state(ws.project)
    assert "review" in snap
    assert len(snap["review"]["comments"]) == 1

    empty = load_project(minimal_project)
    empty.comments = []
    apply_editable_snapshot(empty, snap)
    assert len(empty.comments) == 1
    assert empty.comments[0].body == "Feedback"


def test_comment_add_undo_redo_restores_review(minimal_project):
    """review must be in ProjectStateSnapshot or after-record is skipped."""
    from podcast_mcp.history import HistoryManager

    ws = ProjectWorkspace.open(minimal_project)
    ws.record_snapshot("baseline", force=True)
    CommentService(ws).add(
        body="Pin",
        author="agent",
        timeline_start=5.0,
        timeline_end=6.0,
    )
    ws = ProjectWorkspace.open(minimal_project)
    labels = [e.label for e in ws.project.history.entries]
    # "before" may be skipped when identical to baseline; "after" must land.
    assert "after add comment" in labels
    assert len(ws.project.comments) == 1

    mgr = HistoryManager(minimal_project)
    mgr.undo(ws.project)
    assert len(ws.project.comments) == 0
    mgr.redo(ws.project)
    assert len(ws.project.comments) == 1
    assert ws.project.comments[0].body == "Pin"


def test_add_reply_domain_and_service(minimal_project, sample_wav, tmp_workspace):
    proj = _with_host(load_project(minimal_project), sample_wav, tmp_workspace)
    c = add_comment(proj, body="Parent", author="caleb", timeline_start=1.0)
    reply = add_reply(proj, c.id, body="Agreed", author="guest")
    assert reply.id
    assert reply.body == "Agreed"
    assert len(c.replies) == 1

    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    result = CommentService(ws).add_reply(c.id, body="On it", author="agent")
    assert result["reply"]["author"] == "agent"
    assert len(CommentService(ws).get(c.id)["replies"]) == 2


def test_comment_body_max_length(minimal_project, sample_wav, tmp_workspace):
    proj = _with_host(load_project(minimal_project), sample_wav, tmp_workspace)
    with pytest.raises(ValueError, match="exceeds"):
        add_comment(
            proj,
            body="x" * (COMMENT_BODY_MAX + 1),
            author="a",
            timeline_start=0.0,
        )
    c = add_comment(
        proj,
        body="ok",
        author="a",
        timeline_start=0.0,
    )
    with pytest.raises(ValueError, match="exceeds"):
        add_reply(proj, c.id, body="y" * (COMMENT_BODY_MAX + 1), author="b")


def test_add_comment_optional_id_is_idempotent(minimal_project, sample_wav, tmp_workspace):
    proj = _with_host(load_project(minimal_project), sample_wav, tmp_workspace)
    first = add_comment(
        proj,
        body="Keep id",
        author="caleb",
        timeline_start=3.0,
        comment_id="live-marker-1",
    )
    assert first.id == "live-marker-1"
    again = add_comment(
        proj,
        body="Keep id",
        author="caleb",
        timeline_start=3.0,
        comment_id="live-marker-1",
    )
    assert again.id == "live-marker-1"
    assert len(proj.comments) == 1
    with pytest.raises(ValueError, match="already exists"):
        add_comment(
            proj,
            body="other",
            author="bea",
            timeline_start=4.0,
            comment_id="live-marker-1",
        )
