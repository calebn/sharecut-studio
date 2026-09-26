from __future__ import annotations

import contextlib
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import filelock
import pytest

from podcast_mcp import project_store as project_store_mod
from podcast_mcp.history import HistoryManager
from podcast_mcp.history import rollback as rollback_mod
from podcast_mcp.history.session import run_mutation
from podcast_mcp.models import EditDecision, EditDecisionType, load_project
from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.project_io import open_project
from podcast_mcp.project_store import ProjectStore, history_index_path, history_snapshot_ids
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.project_state import project_state_lock, snapshot_project


def _decision(id_: str) -> EditDecision:
    return EditDecision(id=id_, track_id="host", type=EditDecisionType.REMOVE, start=0, end=1)


def _labels(path) -> list[str]:
    return [e.label for e in load_project(path).history.entries]


def _setup(minimal_project):
    """Recorded + committed 'initial', then an unrecorded change so record(before) writes."""
    path, proj = open_project(minimal_project)
    HistoryManager(path).record(proj, "initial", force=True)
    ProjectStore(path).commit(proj)
    proj.edit_decisions.append(_decision("unrecorded"))
    return path, proj, history_index_path(proj)


def test_run_mutation_records_history(minimal_project):
    path, proj = open_project(minimal_project)
    run_mutation(
        path,
        proj,
        "before",
        "after",
        lambda p: p.edit_decisions.append(_decision("x")),
    )
    loaded = load_project(path)
    assert len(loaded.edit_decisions) == 1


def test_render_snapshot_waits_for_mutation_to_commit(minimal_project):
    path, project = open_project(minimal_project)
    halfway = Event()
    finish = Event()
    taking_snapshot = Event()

    def edit(live):
        live.name = "intermediate"
        halfway.set()
        assert finish.wait(2)
        live.name = "committed"

    def copy_when_started():
        taking_snapshot.set()
        return snapshot_project(project)

    with ThreadPoolExecutor(max_workers=2) as pool:
        mutation = pool.submit(run_mutation, path, project, "before", "after", edit)
        assert halfway.wait(2)
        snapshot = pool.submit(copy_when_started)
        assert taking_snapshot.wait(2)
        assert not snapshot.done()
        finish.set()
        mutation.result(timeout=2)
        copied = snapshot.result(timeout=2)

    assert copied.name == "committed"


def test_render_and_document_snapshots_share_workspace_lock(minimal_project):
    from podcast_mcp.services.document_sync.service import document_submit_lock

    _, first = open_project(minimal_project)
    _, second = open_project(minimal_project)
    assert first is not second
    assert project_state_lock(first) is project_state_lock(second)
    assert project_state_lock(first) is document_submit_lock(first)


@pytest.mark.parametrize(
    "stage",
    [
        "record_before",
        "mutate",
        "mutate_interrupt",
        "record_after",
        "commit",
        "commit_lock_timeout",
    ],
)
def test_failed_mutation_rolls_back_its_history(minimal_project, monkeypatch, stage):
    path, proj, index_path = _setup(minimal_project)
    index_before = json.loads(index_path.read_text())
    ids_before = history_snapshot_ids(index_path)
    history_before = proj.history.model_copy(deep=True)
    original_record = HistoryManager.record

    def mutate(p):
        if stage == "mutate":
            raise RuntimeError("boom")
        if stage == "mutate_interrupt":
            raise KeyboardInterrupt
        p.edit_decisions.append(_decision("new"))

    def save_index(self, project):
        raise RuntimeError("boom")

    def record(self, project, label, **kwargs):
        if stage == "record_after" and label == "after":
            raise RuntimeError("boom")
        return original_record(self, project, label, **kwargs)

    def commit(self, project):
        if stage == "commit_lock_timeout":
            raise filelock.Timeout("lock")
        raise RuntimeError("boom")

    monkeypatch.setattr(HistoryManager, "record", record)
    if stage == "record_before":
        monkeypatch.setattr(HistoryManager, "_save_index", save_index)
    if stage in ("commit", "commit_lock_timeout"):
        monkeypatch.setattr(ProjectStore, "commit", commit)
    expected = {"commit_lock_timeout": filelock.Timeout, "mutate_interrupt": KeyboardInterrupt}.get(
        stage, RuntimeError
    )
    with pytest.raises(expected):
        run_mutation(path, proj, "before", "after", mutate)

    assert json.loads(index_path.read_text()) == index_before
    assert history_snapshot_ids(index_path) == ids_before
    assert proj.history == history_before
    assert HistoryManager(path).status(proj).total == 1
    if stage in ("mutate", "mutate_interrupt"):
        assert [d.id for d in proj.edit_decisions] == ["unrecorded"]


def test_failed_mutation_keeps_the_redo_branch(minimal_project):
    path, proj = open_project(minimal_project)
    mgr = HistoryManager(path)
    mgr.record(proj, "initial", force=True)
    ProjectStore(path).commit(proj)
    run_mutation(path, proj, "b1", "a1", lambda p: p.edit_decisions.append(_decision("one")))
    mgr.undo(proj)
    proj.edit_decisions.append(_decision("unrecorded"))

    def fail(_p):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        run_mutation(path, proj, "b2", "a2", fail)

    assert mgr.status(proj).can_redo
    assert proj.history.cursor == 0
    assert len(proj.history.entries) == 2


def test_failed_mutation_keeps_entries_another_writer_recorded_on_top(minimal_project, caplog):
    path, proj, index_path = _setup(minimal_project)

    def fn(_p):
        other = ProjectStore(path).load()
        HistoryManager(path).record(other, "other writer", force=True)
        raise RuntimeError("boom")

    with caplog.at_level(logging.WARNING):
        with pytest.raises(RuntimeError, match="boom"):
            run_mutation(path, proj, "before", "after", fn)

    labels = [e["label"] for e in json.loads(index_path.read_text())["entries"]]
    assert labels[-1] == "other writer"
    assert set(labels) <= {"initial", "before", "other writer"}
    assert "keeping its entries" in caplog.text
    assert [e.label for e in proj.history.entries] == labels


def test_commit_that_landed_keeps_its_history(minimal_project, monkeypatch):
    path, proj, index_path = _setup(minimal_project)
    original = ProjectStore.commit

    def commit_then_fail(self, project):
        original(self, project)
        raise RuntimeError("late")

    monkeypatch.setattr(ProjectStore, "commit", commit_then_fail)
    with pytest.raises(RuntimeError, match="late"):
        run_mutation(
            path, proj, "before", "after", lambda p: p.edit_decisions.append(_decision("n"))
        )

    expected = ["initial", "before", "after"]
    assert [e["label"] for e in json.loads(index_path.read_text())["entries"]] == expected
    assert _labels(path) == expected
    assert len(history_snapshot_ids(index_path)) == 3
    assert [e.label for e in proj.history.entries] == expected


def test_failed_mutation_leaves_history_on_disk_when_project_file_cannot_be_stated(
    minimal_project, monkeypatch, caplog
):
    path, proj, index_path = _setup(minimal_project)

    def revision(_project):
        raise OSError("stat")

    monkeypatch.setattr(project_store_mod, "project_file_revision", revision)

    def commit(self, project):
        raise RuntimeError("boom")

    monkeypatch.setattr(ProjectStore, "commit", commit)
    history_before = proj.history.model_copy(deep=True)
    with caplog.at_level(logging.WARNING):
        with pytest.raises(RuntimeError, match="boom"):
            run_mutation(path, proj, "before", "after", lambda p: None)

    assert "Could not stat" in caplog.text
    labels = [e["label"] for e in json.loads(index_path.read_text())["entries"]]
    assert "before" in labels
    assert len(history_snapshot_ids(index_path)) == len(labels)
    assert proj.history == history_before


def test_rollback_failure_is_logged_and_the_original_error_raised(
    minimal_project, monkeypatch, caplog
):
    path, proj, index_path = _setup(minimal_project)

    def broken(*_a, **_k):
        raise OSError("disk")

    monkeypatch.setattr(rollback_mod, "rollback_own_history", broken)

    def fail(_p):
        raise RuntimeError("boom")

    with caplog.at_level(logging.WARNING):
        with pytest.raises(RuntimeError, match="boom"):
            run_mutation(path, proj, "before", "after", fail)
    assert "Could not roll back" in caplog.text
    assert proj.history.model_dump(mode="json") == json.loads(index_path.read_text())


def test_unreadable_index_after_a_failed_mutation_restores_history_before(minimal_project, caplog):
    path, proj, index_path = _setup(minimal_project)
    history_before = proj.history.model_copy(deep=True)

    def fn(_p):
        index_path.write_text("{", encoding="utf-8")
        raise RuntimeError("boom")

    with caplog.at_level(logging.WARNING):
        with pytest.raises(RuntimeError, match="boom"):
            run_mutation(path, proj, "before", "after", fn)
    assert "Could not roll back" in caplog.text
    assert proj.history == history_before


def test_rollback_checks_the_commit_under_the_same_lock_hold(minimal_project, monkeypatch):
    path, proj, _ = _setup(minimal_project)
    real_lock = rollback_mod.project_commit_lock
    real_revision = project_store_mod.project_file_revision
    depth = 0
    held = []

    @contextlib.contextmanager
    def lock(project):
        nonlocal depth
        with real_lock(project):
            depth += 1
            try:
                yield
            finally:
                depth -= 1

    def revision(project):
        held.append(depth > 0)
        return real_revision(project)

    def commit(self, project):
        raise RuntimeError("boom")

    monkeypatch.setattr(rollback_mod, "project_commit_lock", lock)
    monkeypatch.setattr(project_store_mod, "project_file_revision", revision)
    monkeypatch.setattr(ProjectStore, "commit", commit)
    with pytest.raises(RuntimeError, match="boom"):
        run_mutation(path, proj, "before", "after", lambda p: None)
    assert held == [True]


def test_failed_record_snapshot_rolls_back_its_entry(minimal_project, monkeypatch):
    path, proj, index_path = _setup(minimal_project)
    ws = ProjectWorkspace(path, proj)
    index_before = json.loads(index_path.read_text())
    ids_before = history_snapshot_ids(index_path)
    history_before = proj.history.model_copy(deep=True)

    def commit(self, project):
        raise RuntimeError("boom")

    monkeypatch.setattr(ProjectStore, "commit", commit)
    with pytest.raises(RuntimeError, match="boom"):
        ws.record_snapshot("manual", force=True)
    assert json.loads(index_path.read_text()) == index_before
    assert history_snapshot_ids(index_path) == ids_before
    assert ws.project.history == history_before


def test_failed_mutation_removes_an_index_that_did_not_exist(minimal_project):
    path, proj = open_project(minimal_project)
    index_path = history_index_path(proj)
    if index_path.exists():
        index_path.unlink()
    proj.history = ProjectHistory()
    proj.edit_decisions.append(_decision("unrecorded"))

    def fail(_p):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        run_mutation(path, proj, "before", "after", fail)
    assert not index_path.exists()
    assert history_snapshot_ids(index_path) == set()
    assert proj.history.is_empty()


def test_failed_mutation_restores_a_corrupt_index_from_the_project_history(minimal_project):
    path, proj, index_path = _setup(minimal_project)
    ids_before = history_snapshot_ids(index_path)
    history_before = proj.history.model_copy(deep=True)
    index_path.write_text("{", encoding="utf-8")

    def fail(_p):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        run_mutation(path, proj, "before", "after", fail)
    assert json.loads(index_path.read_text()) == history_before.model_dump(mode="json")
    assert history_snapshot_ids(index_path) == ids_before
    assert proj.history == history_before
