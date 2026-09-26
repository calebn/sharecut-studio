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
from podcast_mcp.services import CommentService, ProjectWorkspace, ReviewService
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.service import document_db_path
from podcast_mcp.services.session_sync.log import SyncStore
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
    try:
        with pytest.raises(Timeout):
            ProjectStore(minimal_project).commit(project)
    finally:
        release.set()
        proc.join(30)
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
    assert encoded == ["mix.mp3"]
    review_root = art / "review"
    assert not review_root.exists() or not any(review_root.iterdir())
    assert load_project(minimal_project).review.versions == []


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


def _child_add_comment(path, body) -> None:
    CommentService(ProjectWorkspace.open(path)).add(body=body, author="child", timeline_start=1.0)


def _child_submit_comments(path, client_id, start, count) -> None:
    svc = DocumentSyncService.open(path)
    start.wait(60)
    for seq in range(1, count + 1):
        svc.submit(
            DocumentCommand(
                type="AddComment",
                payload={"body": f"{client_id}-{seq}", "author": client_id, "timeline_start": 1.0},
                client_id=client_id,
                role="viewer",
                client_seq=seq,
            )
        )


def test_mutate_takes_the_lock_before_running_the_mutation(minimal_project, monkeypatch):
    project = load_project(minimal_project)
    lock_path = project_commit_lock_path(project)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    ws = ProjectWorkspace.open(minimal_project)
    monkeypatch.setattr(project_state, "PROJECT_COMMIT_LOCK_TIMEOUT_SEC", 0.3)
    ready, release = _CTX.Event(), _CTX.Event()
    holder = _CTX.Process(target=_hold_lock, args=(str(lock_path), ready, release))
    holder.start()
    try:
        assert ready.wait(60)
        called: list[int] = []
        with pytest.raises(Timeout):
            ws.mutate("b", "a", lambda _p: called.append(1))
        assert called == []
    finally:
        release.set()
        holder.join(60)
    assert load_project(minimal_project).comments == []


def test_document_submit_waits_for_another_process_holding_the_commit_lock(
    minimal_project, monkeypatch
):
    project = load_project(minimal_project)
    lock_path = project_commit_lock_path(project)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    svc = DocumentSyncService.open(minimal_project)
    cmd = DocumentCommand(
        type="AddComment",
        payload={"body": "wait", "author": "v", "timeline_start": 1.0},
        client_id="v",
        role="viewer",
        client_seq=1,
    )
    monkeypatch.setattr(project_state, "PROJECT_COMMIT_LOCK_TIMEOUT_SEC", 0.3)
    ready, release = _CTX.Event(), _CTX.Event()
    holder = _CTX.Process(target=_hold_lock, args=(str(lock_path), ready, release))
    holder.start()
    try:
        assert ready.wait(60)
        with pytest.raises(Timeout):
            svc.submit(cmd)
    finally:
        release.set()
        holder.join(60)
    assert load_project(minimal_project).comments == []
    assert svc.store.commands_after(0) == []
    assert svc.submit(cmd)["ok"]
    assert [c.body for c in load_project(minimal_project).comments] == ["wait"]


def test_stale_workspace_keeps_a_commit_from_another_process(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    child = _CTX.Process(target=_child_add_comment, args=(str(minimal_project), "theirs"))
    child.start()
    child.join(60)
    assert child.exitcode == 0
    CommentService(ws).add(body="ours", author="me", timeline_start=1.0)
    assert {c.body for c in load_project(minimal_project).comments} == {"theirs", "ours"}


def test_document_commands_from_two_processes_keep_every_edit(minimal_project):
    start = _CTX.Event()
    children = [
        _CTX.Process(target=_child_submit_comments, args=(str(minimal_project), cid, start, 5))
        for cid in ("a", "b")
    ]
    for child in children:
        child.start()
    start.set()
    for child in children:
        child.join(120)
        assert child.exitcode == 0
    project = load_project(minimal_project)
    bodies = {c.body for c in project.comments}
    assert len(project.comments) == 10
    store = SyncStore(document_db_path(project))
    try:
        rows = store.commands_after(0)
    finally:
        store.close()
    assert len(rows) == 10
    seqs = [r["server_seq"] for r in rows]
    assert seqs == sorted(set(seqs))
    assert {r["payload"]["body"] for r in rows} == bodies


def _child_submit_one(path, body, start, results) -> None:
    svc = DocumentSyncService.open(path)
    start.wait(60)
    try:
        svc.submit(
            DocumentCommand(
                type="AddComment",
                payload={"body": body, "author": "x", "timeline_start": 1.0},
                client_id="shared",
                role="viewer",
                client_seq=1,
            )
        )
        results.put("ok")
    except Exception as exc:
        results.put(type(exc).__name__)


def test_same_sequence_race_across_processes_journals_only_the_applied_edit(minimal_project):
    start, results = _CTX.Event(), _CTX.Queue()
    children = [
        _CTX.Process(target=_child_submit_one, args=(str(minimal_project), body, start, results))
        for body in ("left", "right")
    ]
    for child in children:
        child.start()
    start.set()
    for child in children:
        child.join(120)
    outcomes = sorted(results.get(timeout=10) for _ in children)
    assert outcomes == ["DocumentSequenceConflictError", "ok"]
    project = load_project(minimal_project)
    assert len(project.comments) == 1
    store = SyncStore(document_db_path(project))
    try:
        rows = store.commands_after(0)
    finally:
        store.close()
    assert len(rows) == 1
    assert rows[0]["payload"]["body"] == project.comments[0].body
