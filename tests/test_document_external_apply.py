from __future__ import annotations

import pytest

from podcast_mcp.project.merge import project_merge_data
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document_sync import DocumentSyncService, apply_external_document_edit
from podcast_mcp.util.coded_error import CodedValueError


def _types(path):
    return [row["type"] for row in DocumentSyncService.open(path).store.commands_after(0)]


def test_external_edit_preserves_result_and_compares_saved_state(tmp_path):
    ws = ProjectWorkspace.create(tmp_path / "episode")
    returned = {"count": 0}

    def apply():
        assert project_merge_data(ws.project) == project_merge_data(
            ProjectWorkspace.open(ws.path).project
        )
        TimelineService(ws).add_chapter(1, "Intro")
        assert project_merge_data(ws.project) == project_merge_data(
            ProjectWorkspace.open(ws.path).project
        )
        return returned

    assert apply_external_document_edit(ws, apply) is returned
    assert _types(ws.path) == ["ExternalMutate"]
    assert [c.title for c in ProjectWorkspace.open(ws.path).project.chapters] == ["Intro"]


def test_external_edit_does_not_publish_an_unchanged_result(tmp_path):
    ws = ProjectWorkspace.create(tmp_path / "episode")
    returned = {"count": 7, "applied": True}
    before = ws.path.read_bytes()
    assert apply_external_document_edit(ws, lambda: returned) is returned
    assert ws.path.read_bytes() == before
    assert _types(ws.path) == []


def test_external_edit_preserves_error_and_does_not_publish(tmp_path):
    ws = ProjectWorkspace.create(tmp_path / "episode")
    error = CodedValueError("bad edit", code="bad_edit")

    def fail():
        raise error

    with pytest.raises(CodedValueError) as raised:
        apply_external_document_edit(ws, fail)
    assert raised.value is error
    assert _types(ws.path) == []


def test_external_edit_publishes_a_committed_history_only_change(tmp_path):
    ws = ProjectWorkspace.create(tmp_path / "episode")
    apply_external_document_edit(ws, lambda: ws.record_snapshot("remember", force=True))
    saved = ProjectWorkspace.open(ws.path).project
    assert [entry.label for entry in saved.history.entries] == ["initial", "remember"]
    assert _types(ws.path) == ["ExternalMutate"]


def test_external_edit_adopts_a_concurrent_commit_before_comparing(tmp_path):
    stale = ProjectWorkspace.create(tmp_path / "episode")
    TimelineService(ProjectWorkspace.open(stale.path)).add_chapter(1, "Other writer")
    apply_external_document_edit(stale, lambda: TimelineService(stale).add_chapter(2, "CLI"))
    assert [c.title for c in ProjectWorkspace.open(stale.path).project.chapters] == [
        "Other writer",
        "CLI",
    ]
    assert _types(stale.path) == ["ExternalMutate"]


def test_external_edit_keeps_best_effort_notification_failure(tmp_path, monkeypatch, caplog):
    ws = ProjectWorkspace.create(tmp_path / "episode")

    def fail(self, **kwargs):
        raise RuntimeError("journal unavailable")

    monkeypatch.setattr(DocumentSyncService, "publish_document_changed", fail)
    result = apply_external_document_edit(ws, lambda: TimelineService(ws).add_chapter(1, "Intro"))
    assert result["title"] == "Intro"
    assert [c.title for c in ProjectWorkspace.open(ws.path).project.chapters] == ["Intro"]
    assert "journal unavailable" in caplog.text
    assert _types(ws.path) == []


def _write_concurrently(path, blocked, returned):
    from process_helpers import observe_failed_commit_lock_attempt

    ws = ProjectWorkspace.open(path)
    with observe_failed_commit_lock_attempt(ws.project, blocked):
        TimelineService(ws).add_chapter(2, "Other writer")
    returned.put("committed")


def test_external_state_samples_exclude_another_process_writer(tmp_path):
    import multiprocessing

    from process_helpers import reap

    ws = ProjectWorkspace.create(tmp_path / "episode")
    ctx = multiprocessing.get_context("spawn")
    blocked, returned = ctx.Event(), ctx.Queue()
    child = ctx.Process(target=_write_concurrently, args=(ws.path, blocked, returned))

    def apply():
        child.start()
        assert blocked.wait(10), "the second writer never attempted the held project lock"
        assert returned.empty()
        TimelineService(ws).add_chapter(1, "CLI")

    try:
        apply_external_document_edit(ws, apply)
    finally:
        assert reap(child, 10)
    assert child.exitcode == 0
    assert returned.get(timeout=1) == "committed"
    assert [c.title for c in ProjectWorkspace.open(ws.path).project.chapters] == [
        "CLI",
        "Other writer",
    ]
    assert _types(ws.path) == ["ExternalMutate"]
