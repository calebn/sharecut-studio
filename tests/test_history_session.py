from __future__ import annotations

import contextlib
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from typing import cast

import filelock
import pytest

from podcast_mcp import project_store as project_store_mod
from podcast_mcp.history import HistoryManager
from podcast_mcp.history import rollback as rollback_mod
from podcast_mcp.history import session as session_mod
from podcast_mcp.history.rollback import RollbackOutcome, take_history_checkpoint
from podcast_mcp.history.session import run_mutation
from podcast_mcp.models import EditDecision, EditDecisionType, load_project
from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.project_io import open_project
from podcast_mcp.project_store import ProjectStore, history_index_path, history_snapshot_ids
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.project_state import (
    project_commit_lock,
    project_state_lock,
    snapshot_project,
)


@pytest.fixture
def rollback_outcomes(monkeypatch):
    outcomes: list[RollbackOutcome] = []
    original = rollback_mod.roll_back_history

    def spy(project, checkpoint):
        outcome = original(project, checkpoint)
        outcomes.append(outcome)
        return outcome

    monkeypatch.setattr(rollback_mod, "roll_back_history", spy)
    return outcomes


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


def test_render_snapshots_and_document_reads_share_the_state_lock(minimal_project):
    """document_submit_lock is the in-process snapshot read lock. Writer serialization across
    processes is pinned by test_document_submit_waits_for_another_process_holding_the_commit_lock
    (test_project_commit_lock.py)."""
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
        "record_after_index",
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
    original_save_index = HistoryManager._save_index

    def mutate(p):
        if stage == "mutate":
            raise RuntimeError("boom")
        if stage == "mutate_interrupt":
            raise KeyboardInterrupt
        p.edit_decisions.append(_decision("new"))

    def save_index(self, project):
        if stage == "record_after_index" and project.history.entries[-1].label != "after":
            return original_save_index(self, project)
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
    if stage in ("record_before", "record_after_index"):
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


def test_failed_mutation_keeps_entries_another_writer_recorded_on_top(
    minimal_project, caplog, rollback_outcomes
):
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
    assert rollback_outcomes == [RollbackOutcome.KEPT]
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
    assert [d.id for d in proj.edit_decisions] == ["unrecorded", "n"]
    assert [d.id for d in load_project(path).edit_decisions] == ["unrecorded", "n"]


def test_failed_mutation_leaves_history_on_disk_when_project_file_cannot_be_stated(
    minimal_project, monkeypatch, caplog, rollback_outcomes
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
            run_mutation(
                path, proj, "before", "after", lambda p: p.edit_decisions.append(_decision("n"))
            )

    assert rollback_outcomes == [RollbackOutcome.UNKNOWN]
    assert [d.id for d in proj.edit_decisions] == ["unrecorded"]
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


@pytest.mark.parametrize("failing", ["commit", "save_index"])
def test_failed_record_snapshot_rolls_back_its_entry(minimal_project, monkeypatch, failing):
    path, proj, index_path = _setup(minimal_project)
    ws = ProjectWorkspace(path, proj)
    index_before = json.loads(index_path.read_text())
    ids_before = history_snapshot_ids(index_path)
    history_before = proj.history.model_copy(deep=True)

    def commit(self, project):
        raise RuntimeError("boom")

    def save_index(self, project):
        raise RuntimeError("boom")

    if failing == "save_index":
        monkeypatch.setattr(HistoryManager, "_save_index", save_index)
    else:
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


def test_rolled_back_on_failure_rolls_back_and_reraises(minimal_project, monkeypatch):
    _path, proj, _index_path = _setup(minimal_project)
    calls = []
    monkeypatch.setattr(rollback_mod, "roll_back_history", lambda p, c: calls.append((p, c)))
    checkpoint = cast(rollback_mod.HistoryCheckpoint, object())
    with pytest.raises(KeyboardInterrupt):
        with rollback_mod.rolled_back_on_failure(proj, checkpoint):
            raise KeyboardInterrupt
    assert calls == [(proj, checkpoint)]
    with rollback_mod.rolled_back_on_failure(proj, checkpoint):
        pass
    assert len(calls) == 1


@pytest.mark.parametrize("outcome", list(RollbackOutcome))
def test_rolled_back_on_failure_calls_on_not_landed_unless_landed(
    minimal_project, monkeypatch, outcome
):
    _path, proj, _index_path = _setup(minimal_project)
    monkeypatch.setattr(rollback_mod, "roll_back_history", lambda _p, _c: outcome)
    calls = []
    checkpoint = cast(rollback_mod.HistoryCheckpoint, object())
    with pytest.raises(RuntimeError, match="boom"):
        with rollback_mod.rolled_back_on_failure(
            proj, checkpoint, on_not_landed=lambda: calls.append(1)
        ):
            raise RuntimeError("boom")
    assert calls == ([] if outcome is RollbackOutcome.LANDED else [1])


def test_roll_back_history_returns_restored_and_landed(minimal_project):
    path, proj, _index_path = _setup(minimal_project)
    store = ProjectStore(path)
    history_before = proj.history.model_copy(deep=True)
    with project_commit_lock(proj):
        checkpoint = take_history_checkpoint(store, proj)
        HistoryManager(path).record(proj, "x")
    assert rollback_mod.roll_back_history(proj, checkpoint) is RollbackOutcome.RESTORED
    assert proj.history == history_before

    with project_commit_lock(proj):
        checkpoint = take_history_checkpoint(store, proj)
        HistoryManager(path).record(proj, "y")
        checkpoint.start_commit(proj)
        store.commit(proj)
    assert rollback_mod.roll_back_history(proj, checkpoint) is RollbackOutcome.LANDED
    assert proj.history.entries[-1].label == "y"


def _ids(project) -> list[str]:
    return [d.id for d in project.edit_decisions]


def _append_new(p) -> None:
    p.edit_decisions.append(_decision("new"))


def test_commit_lock_timeout_restores_the_project_in_memory(
    minimal_project, monkeypatch, rollback_outcomes
):
    path, proj, index_path = _setup(minimal_project)
    index_before = json.loads(index_path.read_text())
    history_before = proj.history.model_copy(deep=True)
    original = session_mod.project_commit_lock
    calls = []

    def lock(project):
        calls.append(1)
        if len(calls) == 2:
            raise filelock.Timeout("lock")
        return original(project)

    monkeypatch.setattr(session_mod, "project_commit_lock", lock)
    with pytest.raises(filelock.Timeout):
        run_mutation(path, proj, "before", "after", _append_new)

    assert _ids(proj) == ["unrecorded"]
    assert proj.history == history_before
    assert json.loads(index_path.read_text()) == index_before
    assert _ids(load_project(path)) == []
    assert rollback_outcomes == [RollbackOutcome.RESTORED]


def test_failed_save_restores_memory_and_index(minimal_project, monkeypatch, rollback_outcomes):
    path, proj, index_path = _setup(minimal_project)
    index_before = json.loads(index_path.read_text())
    ids_before = history_snapshot_ids(index_path)

    def broken(*_a, **_k):
        raise OSError("disk")

    monkeypatch.setattr(project_store_mod, "save_project", broken)
    with pytest.raises(OSError, match="disk"):
        run_mutation(path, proj, "before", "after", _append_new)

    assert _ids(proj) == ["unrecorded"]
    assert json.loads(index_path.read_text()) == index_before
    assert history_snapshot_ids(index_path) == ids_before
    assert rollback_outcomes == [RollbackOutcome.RESTORED]


def test_failed_transcript_mirror_after_save_keeps_the_saved_state(
    minimal_project, monkeypatch, rollback_outcomes
):
    path, proj, _index_path = _setup(minimal_project)

    def broken(*_a, **_k):
        raise RuntimeError("mirror")

    monkeypatch.setattr(ProjectStore, "_mirror_transcript_cache", broken)
    with pytest.raises(RuntimeError, match="mirror"):
        run_mutation(path, proj, "before", "after", _append_new)

    assert _ids(proj) == ["unrecorded", "new"]
    assert _ids(load_project(path)) == _ids(proj)
    assert [e.label for e in proj.history.entries] == ["initial", "before", "after"]
    assert rollback_outcomes == [RollbackOutcome.LANDED]


def test_failed_audio_bookkeeping_restores_render_state(
    minimal_project, monkeypatch, rollback_outcomes
):
    path, proj, _index_path = _setup(minimal_project)
    render_before = proj.render.model_copy(deep=True)
    fingerprints = iter(["a", "b"])
    monkeypatch.setattr(session_mod, "audio_state_fingerprint", lambda _p: next(fingerprints))

    def broken(*_a, **_k):
        raise RuntimeError("bookkeeping")

    monkeypatch.setattr(session_mod, "record_after_audio_mutation", broken)
    with pytest.raises(RuntimeError, match="bookkeeping"):
        run_mutation(path, proj, "before", "after", _append_new)

    assert proj.render == render_before
    assert not proj.render.reconciliation_stale
    assert _ids(proj) == ["unrecorded"]
    assert rollback_outcomes == [RollbackOutcome.RESTORED]


def test_landed_commit_keeps_memory_when_the_rollback_cannot_lock(
    minimal_project, monkeypatch, rollback_outcomes
):
    path, proj, _index_path = _setup(minimal_project)
    original = ProjectStore.commit

    def commit_then_fail(self, project):
        original(self, project)
        raise RuntimeError("late")

    def no_lock(_project):
        raise filelock.Timeout("lock")

    monkeypatch.setattr(ProjectStore, "commit", commit_then_fail)
    monkeypatch.setattr(rollback_mod, "project_commit_lock", no_lock)
    with pytest.raises(RuntimeError, match="late"):
        run_mutation(path, proj, "before", "after", _append_new)

    assert _ids(proj) == _ids(load_project(path)) == ["unrecorded", "new"]
    assert rollback_outcomes == [RollbackOutcome.LANDED]


def test_workspace_mutate_failure_leaves_ws_project_matching_disk(minimal_project, monkeypatch):
    path, _proj, _index_path = _setup(minimal_project)
    ws = ProjectWorkspace.open(path)

    def broken(self, project):
        raise RuntimeError("commit")

    monkeypatch.setattr(ProjectStore, "commit", broken)
    with pytest.raises(RuntimeError, match="commit"):
        ws.mutate("before", "after", _append_new)

    on_disk = load_project(path)
    assert _ids(ws.project) == _ids(on_disk)
    assert ws.project.history == on_disk.history


def _fail_commit(monkeypatch) -> None:
    def broken(self, project):
        raise RuntimeError("commit")

    monkeypatch.setattr(ProjectStore, "commit", broken)


def test_a_raising_rollback_still_restores_memory_and_the_original_error_propagates(
    minimal_project, monkeypatch, caplog
):
    path, proj, _index_path = _setup(minimal_project)

    def broken_rollback(_project, _checkpoint):
        raise RuntimeError("rollback")

    monkeypatch.setattr(rollback_mod, "roll_back_history", broken_rollback)
    _fail_commit(monkeypatch)
    with caplog.at_level(logging.WARNING):
        with pytest.raises(RuntimeError, match="commit"):
            run_mutation(path, proj, "before", "after", _append_new)

    assert _ids(proj) == ["unrecorded"]
    assert "Could not finish rolling back" in caplog.text


def test_an_interrupted_rollback_still_restores_memory(minimal_project, monkeypatch):
    path, proj, _index_path = _setup(minimal_project)

    def interrupted(_project, _checkpoint):
        raise KeyboardInterrupt

    monkeypatch.setattr(rollback_mod, "roll_back_history", interrupted)
    _fail_commit(monkeypatch)
    with pytest.raises(KeyboardInterrupt):
        run_mutation(path, proj, "before", "after", _append_new)

    assert _ids(proj) == ["unrecorded"]


def test_a_failed_memory_restore_is_logged_and_the_original_error_propagates(
    minimal_project, monkeypatch, caplog
):
    path, proj, _index_path = _setup(minimal_project)
    render_before = proj.render.model_copy(deep=True)

    def broken_apply(*_a, **_k):
        raise ValueError("restore")

    monkeypatch.setattr(session_mod, "apply_snapshot_to_project", broken_apply)
    _fail_commit(monkeypatch)
    with caplog.at_level(logging.WARNING):
        with pytest.raises(RuntimeError, match="commit"):
            run_mutation(path, proj, "before", "after", _append_new)

    assert "Could not restore the in-memory project" in caplog.text
    assert proj.render == render_before
