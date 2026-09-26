"""Transcript-refine writes share the document mutation lock."""

from __future__ import annotations

import threading

from podcast_mcp.services import ProjectWorkspace, transcript_refine
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.transcript_refine import TranscriptRefineService


def test_waive_does_not_overwrite_interleaved_document_command(
    minimal_project, monkeypatch
) -> None:
    """A stale waiver workspace cannot save over a command submitted mid-waive."""
    waiver = TranscriptRefineService(ProjectWorkspace.open(minimal_project))
    documents = DocumentSyncService.open(minimal_project)
    reloaded = threading.Event()
    command_started = threading.Event()
    release_waiver = threading.Event()
    failures: list[Exception] = []
    original_waive = transcript_refine.mark_refine_waived

    def pause_in_waive(*args, **kwargs):
        reloaded.set()
        assert release_waiver.wait(timeout=2)
        return original_waive(*args, **kwargs)

    monkeypatch.setattr(transcript_refine, "mark_refine_waived", pause_in_waive)

    original_submit = documents.submit

    def tracked_submit(*args, **kwargs):
        command_started.set()
        return original_submit(*args, **kwargs)

    monkeypatch.setattr(documents, "submit", tracked_submit)

    def run_waive() -> None:
        try:
            waiver.waive(reason="reviewed", source="user")
        except Exception as exc:
            failures.append(exc)

    def submit_comment() -> None:
        try:
            documents.submit(
                DocumentCommand(
                    type="AddComment",
                    payload={"body": "keep this", "author": "viewer", "timeline_start": 1.0},
                    client_id="viewer",
                    role="viewer",
                    client_seq=1,
                )
            )
        except Exception as exc:
            failures.append(exc)

    waive_thread = threading.Thread(target=run_waive)
    waive_thread.start()
    assert reloaded.wait(timeout=2)

    command_thread = threading.Thread(target=submit_comment)
    command_thread.start()
    assert command_started.wait(timeout=2)
    command_thread.join(timeout=0.2)
    assert command_thread.is_alive()
    release_waiver.set()
    waive_thread.join(timeout=2)
    command_thread.join(timeout=2)

    assert not waive_thread.is_alive()
    assert not command_thread.is_alive()
    assert not failures
    comments = DocumentSyncService.open(minimal_project).comments_snapshot()["comments"]
    assert [comment["body"] for comment in comments] == ["keep this"]
