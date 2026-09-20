from __future__ import annotations

import json

import pytest

from podcast_mcp.history import HistoryManager, record_if_changed
from podcast_mcp.models import (
    EditDecision,
    EditDecisionType,
    HistoryEntry,
    SocialClipCandidate,
    load_project,
    save_project,
)


def test_undo_redo_edit_decisions(minimal_project):
    proj = load_project(minimal_project)
    mgr = HistoryManager(minimal_project)
    mgr.record(proj, "empty", force=True)
    save_project(proj, minimal_project)

    proj = load_project(minimal_project)
    proj.edit_decisions.append(
        EditDecision(
            id="1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.0,
            end=0.5,
            reason="filler:um",
        )
    )
    mgr.record(proj, "with edit")
    save_project(proj, minimal_project)

    proj = load_project(minimal_project)
    status = mgr.undo(proj)
    assert status.cursor == 0
    assert len(proj.edit_decisions) == 0

    proj = load_project(minimal_project)
    status = mgr.redo(proj)
    assert status.cursor == 1
    assert len(proj.edit_decisions) == 1

    proj = load_project(minimal_project)
    proj.edit_decisions.clear()
    mgr.record(proj, "cleared")
    save_project(proj, minimal_project)

    proj = load_project(minimal_project)
    status = mgr.status(proj)
    assert status.total == 3
    assert status.cursor == 2
    assert not status.can_redo


def test_undo_at_start_raises(minimal_project):
    proj = load_project(minimal_project)
    mgr = HistoryManager(minimal_project)
    mgr.record(proj, "only", force=True)
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)
    with pytest.raises(ValueError, match="Nothing to undo"):
        mgr.undo(proj)


def test_undo_restores_social_clip_candidates(minimal_project):
    proj = load_project(minimal_project)
    mgr = HistoryManager(minimal_project)
    mgr.record(proj, "no clips", force=True)
    save_project(proj, minimal_project)

    proj = load_project(minimal_project)
    proj.social_clip_candidates.append(
        SocialClipCandidate(
            id="c1",
            track_id="host",
            start=0.0,
            end=20.0,
            score=0.9,
        )
    )
    mgr.record(proj, "with clip")
    save_project(proj, minimal_project)

    proj = load_project(minimal_project)
    mgr.undo(proj)
    assert proj.social_clip_candidates == []


def test_snapshot_files_persist(minimal_project, tmp_path):
    proj = load_project(minimal_project)
    mgr = HistoryManager(minimal_project)
    mgr.record(proj, "snap-a", force=True)
    save_project(proj, minimal_project)
    snap_dir = proj.history_dir() / "snapshots"
    assert snap_dir.is_dir()
    assert any(snap_dir.glob("*.json"))


def test_record_skips_unchanged_snapshot(minimal_project):
    proj = load_project(minimal_project)
    mgr = HistoryManager(minimal_project)
    first = mgr.record(proj, "baseline", force=True)
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)
    second = mgr.record(proj, "baseline again")
    assert second.id == first.id
    assert mgr.status(proj).total == 1


def test_record_truncates_redo_branch(minimal_project):
    proj = load_project(minimal_project)
    mgr = HistoryManager(minimal_project)
    mgr.record(proj, "v1", force=True)
    save_project(proj, minimal_project)

    proj = load_project(minimal_project)
    proj.edit_decisions.append(
        EditDecision(
            id="1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.0,
            end=0.5,
            reason="cut",
        )
    )
    mgr.record(proj, "v2")
    save_project(proj, minimal_project)

    proj = load_project(minimal_project)
    mgr.undo(proj)
    save_project(proj, minimal_project)

    proj = load_project(minimal_project)
    proj.edit_decisions.append(
        EditDecision(
            id="2",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=1.0,
            end=1.5,
            reason="other",
        )
    )
    mgr.record(proj, "v3")
    save_project(proj, minimal_project)

    proj = load_project(minimal_project)
    status = mgr.status(proj)
    assert status.total == 2
    assert status.cursor == 1
    assert not status.can_redo


def test_redo_at_end_raises(minimal_project):
    proj = load_project(minimal_project)
    mgr = HistoryManager(minimal_project)
    mgr.record(proj, "only", force=True)
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)
    with pytest.raises(ValueError, match="Nothing to redo"):
        mgr.redo(proj)


def test_goto_history_index(minimal_project):
    proj = load_project(minimal_project)
    mgr = HistoryManager(minimal_project)
    mgr.record(proj, "start", force=True)
    save_project(proj, minimal_project)

    proj = load_project(minimal_project)
    proj.edit_decisions.append(
        EditDecision(
            id="1",
            track_id="host",
            type=EditDecisionType.REMOVE,
            start=0.0,
            end=0.5,
            reason="cut",
        )
    )
    mgr.record(proj, "edited")
    save_project(proj, minimal_project)

    proj = load_project(minimal_project)
    status = mgr.goto(proj, 0)
    assert status.cursor == 0
    assert status.current_label == "start"
    assert len(proj.edit_decisions) == 0


def test_goto_out_of_range(minimal_project):
    proj = load_project(minimal_project)
    mgr = HistoryManager(minimal_project)
    mgr.record(proj, "only", force=True)
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)
    with pytest.raises(ValueError, match="out of range"):
        mgr.goto(proj, 5)


def test_load_index_from_disk(minimal_project):
    proj = load_project(minimal_project)
    mgr = HistoryManager(minimal_project)
    mgr.record(proj, "persisted", force=True)
    save_project(proj, minimal_project)

    reloaded = load_project(minimal_project)
    reloaded.history = None
    entries = mgr.list_entries(reloaded)
    assert len(entries) == 1
    assert entries[0].label == "persisted"


def test_read_snapshot_invalid_v1_format(minimal_project):
    proj = load_project(minimal_project)
    mgr = HistoryManager(minimal_project)
    entry = mgr.record(proj, "snap", force=True)
    save_project(proj, minimal_project)

    snap_path = proj.workspace_path() / entry.snapshot_file
    snap_path.write_text(json.dumps({"clips": []}), encoding="utf-8")

    proj = load_project(minimal_project)
    with pytest.raises(ValueError, match="not v2 format"):
        mgr._read_snapshot(
            proj, HistoryEntry(id=entry.id, label="x", snapshot_file=entry.snapshot_file)
        )


def test_status_current_label(minimal_project):
    proj = load_project(minimal_project)
    mgr = HistoryManager(minimal_project)
    mgr.record(proj, "labeled", force=True)
    save_project(proj, minimal_project)
    proj = load_project(minimal_project)
    status = mgr.status(proj)
    assert status.current_label == "labeled"


def test_record_if_changed(minimal_project):
    entry = record_if_changed(minimal_project, "via helper", force=True)
    proj = load_project(minimal_project)
    assert proj.history is not None
    assert proj.history.entries[-1].id == entry.id


def test_status_without_entries(minimal_project):
    proj = load_project(minimal_project)
    mgr = HistoryManager(minimal_project)
    status = mgr.status(proj)
    assert status.current_label is None
    assert status.cursor == -1
