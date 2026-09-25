"""Cross-process commit lock: history index + project JSON commit as one transaction."""

from __future__ import annotations

import contextlib
import multiprocessing as mp
import time
from pathlib import Path

import pytest
from filelock import FileLock, Timeout

from podcast_mcp.edits import review_versions
from podcast_mcp.history import HistoryManager
from podcast_mcp.models import load_project
from podcast_mcp.project_store import ProjectStore
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.util import project_state
from podcast_mcp.util.project_state import project_commit_lock, project_commit_lock_path

_CTX = mp.get_context("spawn")


def _hold_lock(path: str, ready, release) -> None:
    with FileLock(path):
        ready.set()
        release.wait(20)


def _fake_mp3(self, wav, mp3, *, bitrate_kbps):
    mp3.write_bytes(b"encoded")


def _child_failed_publish(project_path, publishing, may_clean, cleaned) -> None:
    from podcast_mcp.services import review as review_service

    review_versions.FFmpegEngine.export_mp3 = _fake_mp3

    def fail_commit(self, project):
        publishing.set()
        raise RuntimeError("commit failed")

    real_clean = review_service.clean_created_version

    def slow_clean(*args, **kwargs):
        may_clean.wait(20)
        real_clean(*args, **kwargs)
        cleaned.set()

    ProjectStore.commit = fail_commit
    review_service.clean_created_version = slow_clean
    with contextlib.suppress(RuntimeError):
        ReviewService(ProjectWorkspace.open(project_path)).publish(label="doomed")


def _child_goto(project_path, index, adopted, result) -> None:
    """Adopt the failing publication's uncommitted index, then jump to its last entry."""
    store = ProjectStore(Path(project_path))
    project = store.load()
    mgr = HistoryManager(Path(project_path))
    adopted.set()
    try:
        mgr.goto(project, index)
        result.put("ok")
    except Exception as exc:
        result.put(type(exc).__name__)


def test_lock_is_reentrant_and_shared_per_workspace(minimal_project):
    project = load_project(minimal_project)
    with project_commit_lock(project), project_commit_lock(load_project(minimal_project)):
        assert project_commit_lock_path(project).is_file()
    assert project_commit_lock_path(project).parent.name == "artifacts"
    assert "history" not in project_commit_lock_path(project).parts


def test_commit_waits_for_lock_held_by_another_process(minimal_project, monkeypatch):
    project = load_project(minimal_project)
    lock_path = project_commit_lock_path(project)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    ready, release = _CTX.Event(), _CTX.Event()
    proc = _CTX.Process(target=_hold_lock, args=(str(lock_path), ready, release))
    proc.start()
    assert ready.wait(30)
    monkeypatch.setattr(project_state, "PROJECT_COMMIT_LOCK_TIMEOUT_SEC", 0.3)
    project_state._file_locks.clear()
    try:
        with pytest.raises(Timeout):
            ProjectStore(minimal_project).commit(project)
    finally:
        release.set()
        proc.join(30)
        project_state._file_locks.clear()
    ProjectStore(minimal_project).commit(project)


def test_publication_encodes_while_another_process_holds_lock(
    minimal_project, sample_wav, monkeypatch
):
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    ready, release = _CTX.Event(), _CTX.Event()
    proc = _CTX.Process(
        target=_hold_lock, args=(str(project_commit_lock_path(project)), ready, release)
    )
    proc.start()
    assert ready.wait(30)
    monkeypatch.setattr(project_state, "PROJECT_COMMIT_LOCK_TIMEOUT_SEC", 0.3)
    project_state._file_locks.clear()
    encoded: list[str] = []

    def spy(self, wav, mp3, *, bitrate_kbps):
        encoded.append(mp3.name)
        _fake_mp3(self, wav, mp3, bitrate_kbps=bitrate_kbps)

    monkeypatch.setattr(review_versions.FFmpegEngine, "export_mp3", spy)
    try:
        with pytest.raises(Timeout):
            ReviewService(ProjectWorkspace.open(minimal_project)).publish(label="x")
    finally:
        release.set()
        proc.join(30)
        project_state._file_locks.clear()
    assert encoded == ["mix.mp3"]


def test_failed_publication_cleanup_is_not_raced_by_history_goto(minimal_project, sample_wav):
    project = load_project(minimal_project)
    art = Path(project.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    original = review_versions.FFmpegEngine.export_mp3
    review_versions.FFmpegEngine.export_mp3 = _fake_mp3
    try:
        ReviewService(ProjectWorkspace.open(minimal_project)).publish(label="kept")
    finally:
        review_versions.FFmpegEngine.export_mp3 = original
    persisted = load_project(minimal_project)
    kept_ids = [v.id for v in persisted.review.versions]
    doomed_index = len(HistoryManager(minimal_project).list_entries(persisted))

    publishing, may_clean, cleaned = _CTX.Event(), _CTX.Event(), _CTX.Event()
    a = _CTX.Process(
        target=_child_failed_publish, args=(minimal_project, publishing, may_clean, cleaned)
    )
    a.start()
    assert publishing.wait(60)
    adopted, result = _CTX.Event(), _CTX.Queue()
    b = _CTX.Process(target=_child_goto, args=(minimal_project, doomed_index, adopted, result))
    b.start()
    assert adopted.wait(60)
    time.sleep(1.0)
    may_clean.set()
    assert cleaned.wait(60)
    a.join(60)
    b.join(60)
    assert result.get(timeout=10) != "ok"

    persisted = load_project(minimal_project)
    assert [v.id for v in persisted.review.versions] == kept_ids
    for ver in persisted.review.versions:
        assert (Path(persisted.workspace_dir) / ver.audio_relpath).is_file()
    review_root = art / "review"
    assert sorted(p.name for p in review_root.iterdir()) == sorted(kept_ids)
