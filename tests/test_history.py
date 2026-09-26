from __future__ import annotations

import json
import threading
from pathlib import Path

import pytest

from podcast_mcp.history import HistoryManager, record_if_changed
from podcast_mcp.history.manager import snapshot_from_project, write_snapshot
from podcast_mcp.models import (
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    HistoryEntry,
    SocialClipCandidate,
    load_project,
    save_project,
)
from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.project_store import ProjectStore, history_index_path, history_snapshot_path
from podcast_mcp.util import atomic_json


@pytest.mark.parametrize("writer", ["history_manager", "project_store"])
def test_history_index_is_published_atomically(minimal_project, monkeypatch, writer):
    project = load_project(minimal_project)
    manager = HistoryManager(minimal_project)
    first = manager.record(project, "initial", force=True)
    save_project(project, minimal_project)

    index_path = project.workspace_path() / "history" / "index.json"
    previous = json.loads(index_path.read_text(encoding="utf-8"))
    replace_started = threading.Event()
    release_replace = threading.Event()
    original_replace = atomic_json.os.replace

    def block_index_replace(source: str | Path, destination: str | Path) -> None:
        if Path(destination) == index_path:
            replace_started.set()
            assert release_replace.wait(timeout=5), "index replacement did not release"
        original_replace(source, destination)

    monkeypatch.setattr(atomic_json.os, "replace", block_index_replace)

    if writer == "history_manager":

        def publish() -> None:
            manager.record(project, "next", force=True)

    else:
        history = ProjectHistory(
            entries=[
                *project.history.entries,
                HistoryEntry(
                    id="next",
                    label="next",
                    snapshot_file=first.snapshot_file,
                ),
            ],
            cursor=1,
        )
        project.history = history
        store = ProjectStore(minimal_project)

        def publish() -> None:
            store._sync_history_index_to_project(project)

    errors: list[BaseException] = []

    def run_publish() -> None:
        try:
            publish()
        except BaseException as exc:
            errors.append(exc)

    thread = threading.Thread(target=run_publish)
    thread.start()
    try:
        assert replace_started.wait(timeout=5), "index publication did not reach os.replace"

        pending = json.loads(index_path.read_text(encoding="utf-8"))
        assert pending == previous
    finally:
        release_replace.set()
        thread.join(timeout=5)

    assert not thread.is_alive()
    assert not errors

    published = json.loads(index_path.read_text(encoding="utf-8"))
    assert len(published["entries"]) == 2
    if writer == "project_store":
        assert published["entries"][-1]["id"] == "next"
    else:
        assert published["entries"][-1]["label"] == "next"


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
    reloaded.history = ProjectHistory()
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
    assert proj.history.entries[-1].id == entry.id


def test_status_without_entries(minimal_project):
    proj = load_project(minimal_project)
    mgr = HistoryManager(minimal_project)
    status = mgr.status(proj)
    assert status.current_label is None
    assert status.cursor == -1


def test_new_project_has_empty_history_object(tmp_path):
    proj = EpisodeProject.create("fresh", str(tmp_path))
    assert proj.history == ProjectHistory()
    assert proj.history.is_empty()
    dumped = proj.model_dump(mode="json", by_alias=True)
    assert dumped["history"] == {"cursor": -1, "entries": []}


def test_legacy_null_history_loads_as_empty(minimal_project):
    data = json.loads(minimal_project.read_text(encoding="utf-8"))
    data["history"] = None
    minimal_project.write_text(json.dumps(data), encoding="utf-8")
    proj = load_project(minimal_project)
    assert proj.history == ProjectHistory()
    save_project(proj, minimal_project)
    saved = json.loads(minimal_project.read_text(encoding="utf-8"))
    assert saved["history"] == {"cursor": -1, "entries": []}


def test_store_load_prefers_index_over_empty_history(minimal_project):
    proj = load_project(minimal_project)
    HistoryManager(minimal_project).record(proj, "indexed", force=True)
    data = json.loads(minimal_project.read_text(encoding="utf-8"))
    data["history"] = {"cursor": -1, "entries": []}
    minimal_project.write_text(json.dumps(data), encoding="utf-8")
    loaded = ProjectStore(minimal_project).load()
    assert [e.label for e in loaded.history.entries] == ["indexed"]


def test_snapshot_file_uses_the_shared_layout(minimal_project):
    proj = load_project(minimal_project)
    entry = HistoryManager(minimal_project).record(proj, "snap", force=True)
    assert entry.snapshot_file == f"history/snapshots/{entry.id}.json"
    assert history_snapshot_path(history_index_path(proj), entry.id).is_file()


def test_record_if_changed_rolls_back_when_the_commit_fails(minimal_project, monkeypatch):
    import json

    from podcast_mcp.models import load_project
    from podcast_mcp.project_store import ProjectStore, history_index_path, history_snapshot_ids

    record_if_changed(minimal_project, "initial", force=True)
    index_path = history_index_path(load_project(minimal_project))
    index_before = json.loads(index_path.read_text())
    ids_before = history_snapshot_ids(index_path)

    def commit(self, project):
        raise RuntimeError("boom")

    monkeypatch.setattr(ProjectStore, "commit", commit)
    with pytest.raises(RuntimeError, match="boom"):
        record_if_changed(minimal_project, "manual", force=True)
    assert json.loads(index_path.read_text()) == index_before
    assert history_snapshot_ids(index_path) == ids_before


def test_record_if_changed_rolls_back_when_the_index_write_fails(minimal_project, monkeypatch):
    import json

    from podcast_mcp.models import load_project
    from podcast_mcp.project_store import history_index_path, history_snapshot_ids

    record_if_changed(minimal_project, "initial", force=True)
    index_path = history_index_path(load_project(minimal_project))
    index_before = json.loads(index_path.read_text())
    ids_before = history_snapshot_ids(index_path)

    def save_index(self, project):
        raise RuntimeError("boom")

    monkeypatch.setattr(HistoryManager, "_save_index", save_index)
    with pytest.raises(RuntimeError, match="boom"):
        record_if_changed(minimal_project, "manual", force=True)
    assert json.loads(index_path.read_text()) == index_before
    assert history_snapshot_ids(index_path) == ids_before


def test_write_snapshot_round_trips_through_read(minimal_project):
    proj = load_project(minimal_project)
    rel = write_snapshot(proj, snapshot_from_project(proj), "shared-writer")
    assert rel == "history/snapshots/shared-writer.json"
    entry = HistoryEntry(id="shared-writer", label="snap", snapshot_file=rel)
    restored = HistoryManager(minimal_project)._read_snapshot(proj, entry)
    assert restored.model_dump() == snapshot_from_project(proj).model_dump()
