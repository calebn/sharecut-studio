"""A clip's timing map survives split, move, undo and redo through the document (#2859)."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, save_project
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import DocumentCommand


@pytest.fixture(autouse=True)
def _dispatcher_grant():
    with write_grant(WriteGrantKind.DISPATCHER):
        yield


@pytest.fixture
def timed_project(tmp_path: Path) -> Path:
    project = EpisodeProject.create("timed_history", str(tmp_path))
    project.ensure_dirs()
    project.timeline.tracks = [
        Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav", duration_sec=300.0))
    ]
    project.timeline.clips = [
        Clip.model_validate(
            {
                "id": "a",
                "track_id": "host",
                "source_start": 10,
                "source_end": 40,
                "timeline_start": 100,
                "timing": {"steps": [{"at": 20, "delta_sec": 2}]},
            }
        )
    ]
    return save_project(project)


def _clips(path: Path) -> list[tuple[dict, dict | None]]:
    clips = ProjectWorkspace.open(path).project.clips
    return [(c.model_dump(), c.timing.model_dump() if c.timing else None) for c in clips]


def _submit(path: Path, seq: int, kind: str, payload: dict) -> None:
    command = DocumentCommand(
        type=kind, payload=payload, client_id="timed-history", role="viewer", client_seq=seq
    )
    assert DocumentSyncService.open(path).submit(command)["ok"]


def _history(path: Path, seq: int, kind: str) -> None:
    head = ProjectWorkspace.open(path).project.history.head_id()
    _submit(path, seq, kind, {"expected_head_id": head, "rerender": False})


def test_undo_and_redo_restore_the_timing_map_of_every_half(timed_project: Path) -> None:
    start = _clips(timed_project)
    _submit(timed_project, 1, "SplitAtTime", {"at_time": 115.0, "track_ids": ["host"]})
    split = _clips(timed_project)
    assert len(split) == 2
    assert any(timing for _, timing in split)
    second = next(c["id"] for c, _ in split if c["id"] != "a")
    moves = [{"clip_id": second, "timeline_start": 200.0, "track_id": "host"}]
    _submit(timed_project, 2, "MoveClips", {"clips": moves})
    moved = _clips(timed_project)
    assert moved != split

    _history(timed_project, 3, "UndoHistory")
    _history(timed_project, 4, "UndoHistory")
    assert _clips(timed_project) == start
    _history(timed_project, 5, "RedoHistory")
    _history(timed_project, 6, "RedoHistory")
    assert _clips(timed_project) == moved
    _history(timed_project, 7, "UndoHistory")
    assert _clips(timed_project) == split
