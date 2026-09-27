"""A crash between the project commit and the journal INSERT/COMMIT still gets
journaled by the next submit (#575)."""

from __future__ import annotations

import multiprocessing as mp
import os
import signal
import sys

import pytest

from podcast_mcp.models import load_project
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.service import document_db_path
from podcast_mcp.services.session_sync.log import SyncStore

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="SIGKILL is not available on win32")

_CTX = mp.get_context("spawn")


def _crash_command() -> DocumentCommand:
    return DocumentCommand(
        type="AddComment",
        payload={"body": "crash", "author": "v", "timeline_start": 1.0},
        client_id="v",
        role="viewer",
        client_seq=1,
        command_id="crash-1",
    )


def _submit_then_die(project_path: str, stage: str) -> None:
    """Submit "crash-1", killing the process at ``stage`` of the journal write."""
    real_append_and_apply = SyncStore.append_and_apply

    def killing_append_and_apply(self, *, command_id, **kwargs):
        if command_id != "crash-1":
            return real_append_and_apply(self, command_id=command_id, **kwargs)
        if stage == "after_project_commit":
            # The project commit (with document_sync.last_command) has already landed;
            # die before the journal write even starts.
            os.kill(os.getpid(), signal.SIGKILL)

        real_apply_fn = kwargs["apply_fn"]

        def killing_apply_fn(snap, appended):
            # The INSERT has run inside the open transaction; die before COMMIT.
            os.kill(os.getpid(), signal.SIGKILL)
            return real_apply_fn(snap, appended)  # pragma: no cover - never reached

        return real_append_and_apply(
            self, command_id=command_id, **{**kwargs, "apply_fn": killing_apply_fn}
        )

    SyncStore.append_and_apply = killing_append_and_apply  # type: ignore[method-assign]
    svc = DocumentSyncService.open(project_path)
    svc.submit(_crash_command())


@pytest.mark.parametrize("stage", ["after_project_commit", "after_journal_insert"])
def test_sigkill_between_project_commit_and_journal_is_replayed_once(minimal_project, stage):
    proc = _CTX.Process(target=_submit_then_die, args=(str(minimal_project), stage))
    proc.start()
    proc.join(60)
    assert proc.exitcode == -signal.SIGKILL

    project = load_project(minimal_project)
    assert [c.body for c in project.comments] == ["crash"]
    saved = project.document_sync.last_command
    assert saved is not None
    assert saved.command_id == "crash-1"

    store = SyncStore(document_db_path(project))
    try:
        assert store.commands_after(0) == []
    finally:
        store.close()

    retry = DocumentSyncService.open(minimal_project)
    result = retry.submit(_crash_command())
    assert result["idempotent"] is True
    assert [c.body for c in load_project(minimal_project).comments] == ["crash"]

    store = SyncStore(document_db_path(project))
    try:
        rows = store.commands_after(0)
    finally:
        store.close()
    assert [(r["command_id"], r["payload"]["result"]) for r in rows] == [("crash-1", None)]

    following = retry.submit(
        DocumentCommand(
            type="AddComment",
            payload={"body": "next", "author": "v", "timeline_start": 2.0},
            client_id="v",
            role="viewer",
            client_seq=2,
        )
    )
    assert following["ok"]
    store = SyncStore(document_db_path(project))
    try:
        rows = store.commands_after(0)
    finally:
        store.close()
    assert len(rows) == 2
