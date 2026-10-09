import sqlite3

import pytest

from history_helpers import history_move
from podcast_mcp.models import Clip, load_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.document_sync.service import document_db_path


def test_raw_fade_after_undo_refuses_without_persisted_changes(minimal_project):
    ws = ProjectWorkspace.open(minimal_project)
    ws.project.timeline.clips = [
        Clip(
            id="fade",
            track_id="host",
            source_start=0,
            source_end=5,
            timeline_start=0,
            fade_in_ms=0,
            fade_out_ms=0,
        )
    ]
    ws.save()
    svc = DocumentSyncService.open(minimal_project)

    def fade(seq, desired, expected):
        return DocumentCommand(
            type="SetClipFade",
            client_id="fade-client",
            role="viewer",
            client_seq=seq,
            payload={
                "clip_id": "fade",
                "fade_in_ms": desired[0],
                "fade_out_ms": desired[1],
                "expected": {"fade_in_ms": expected[0], "fade_out_ms": expected[1]},
            },
        )

    accepted = fade(1, (1, 0), (0, 0))
    assert svc.submit(accepted)["ok"] is True
    after_acceptance = minimal_project.read_bytes()
    assert svc.submit(accepted)["idempotent"] is True
    assert minimal_project.read_bytes() == after_acceptance
    svc.submit(
        DocumentCommand(
            type="UndoHistory",
            client_id="fade-client",
            role="viewer",
            client_seq=2,
            payload=history_move(minimal_project),
        )
    )
    before = minimal_project.read_bytes()
    history = HistoryService(ProjectWorkspace.open(minimal_project)).status()
    sequence = svc.document_snapshot()["server_seq"]
    assert history["can_redo"] is True

    def journal():
        with sqlite3.connect(document_db_path(svc.project)) as connection:
            return connection.execute("SELECT * FROM commands ORDER BY server_seq").fetchall()

    rows = journal()
    with pytest.raises(DocumentConflictError) as refusal:
        svc.submit(fade(3, (1, 1), (1, 0)))
    assert refusal.value.code == "clip_fade_changed"
    assert minimal_project.read_bytes() == before
    assert HistoryService(ProjectWorkspace.open(minimal_project)).status() == history
    assert svc.document_snapshot()["server_seq"] == sequence
    assert journal() == rows
    saved = load_project(minimal_project).clips[0]
    assert (saved.fade_in_ms, saved.fade_out_ms) == (0, 0)
    assert svc.submit(accepted)["idempotent"] is True
    assert minimal_project.read_bytes() == before
    assert journal() == rows
    assert HistoryService(ProjectWorkspace.open(minimal_project)).status() == history
    assert svc.submit(fade(3, (0, 1), (0, 0)))["ok"] is True
    saved = load_project(minimal_project).clips[0]
    assert (saved.fade_in_ms, saved.fade_out_ms) == (0, 1)
    assert len(journal()) == len(rows) + 1
    assert HistoryService(ProjectWorkspace.open(minimal_project)).status()["can_redo"] is False
