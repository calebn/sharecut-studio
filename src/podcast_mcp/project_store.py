from __future__ import annotations

import logging
from collections.abc import Collection, Iterable
from pathlib import Path
from typing import Any

from podcast_mcp.models import EpisodeProject, load_project, project_file_path, save_project
from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic
from podcast_mcp.util.project_state import FileRevision, project_commit_lock, project_file_revision

log = logging.getLogger(__name__)


def history_index_path(project: EpisodeProject) -> Path:
    """``history/index.json`` in ``project``'s workspace."""
    return project.history_dir() / "index.json"


def history_snapshots_dir(index_path: Path) -> Path:
    """Directory holding the history snapshot files beside ``index_path``."""
    return index_path.parent / "snapshots"


def history_snapshot_path(index_path: Path, entry_id: str) -> Path:
    """Snapshot file of history entry ``entry_id`` (``snapshots/<id>.json``)."""
    return history_snapshots_dir(index_path) / f"{entry_id}.json"


def read_history_index(index_path: Path) -> ProjectHistory | None:
    """``history/index.json`` parsed (``None``: it does not exist).

    The one parser of the index. A present but unreadable or invalid index raises
    ``ValueError`` (incl. ``pydantic.ValidationError``); each caller picks its fallback.
    """
    data = load_json_object(index_path)
    return None if data is None else ProjectHistory.model_validate(data)


def restore_history_index(index_path: Path, payload: dict[str, Any] | None) -> None:
    """Put ``history/index.json`` back to ``payload`` read earlier (``None``: it did not exist)."""
    if payload is None:
        index_path.unlink(missing_ok=True)
    else:
        write_json_atomic(index_path, payload)


def history_snapshot_ids(index_path: Path) -> set[str]:
    """Entry ids that have a snapshot file beside ``index_path``."""
    return {p.stem for p in history_snapshots_dir(index_path).glob("*.json")}


def rollback_history(
    index_path: Path, index_before: dict[str, Any] | None, new_entry_ids: Iterable[str]
) -> None:
    """Undo an uncommitted history write: restore the index, then delete the new snapshots.

    Snapshots are removed only once the index no longer lists them, so a failed restore
    raises and leaves them in place.
    """
    restore_history_index(index_path, index_before)
    for entry_id in new_entry_ids:
        history_snapshot_path(index_path, entry_id).unlink(missing_ok=True)


def history_index_to_restore(index_path: Path, fallback: ProjectHistory) -> dict[str, Any] | None:
    """``history/index.json`` as a rollback puts it back (``None``: it does not exist).

    An unreadable index falls back to ``fallback``, which the next commit writes anyway,
    so a corrupt index does not stop every mutation or long job.
    """
    try:
        return load_json_object(index_path)
    except ValueError:
        log.warning(
            "Unreadable %s; a rollback restores it from the project's history",
            index_path,
            exc_info=True,
        )
        return fallback.model_dump(mode="json")


def rollback_own_history(
    index_path: Path,
    index_before: dict[str, Any] | None,
    own_indexes: Collection[dict[str, Any] | None],
    own_entry_ids: Iterable[str],
) -> bool:
    """Undo this caller's history writes unless another writer recorded on top.

    Call under ``project_commit_lock``. The index is rolled back only if it still equals
    ``index_before`` or one of ``own_indexes`` (payloads this caller wrote); otherwise
    nothing is touched and ``False`` is returned.

    Ownership is decided by payload equality, not identity. That assumes distinct writers
    never produce an identical payload, which holds because every recorded entry gets a
    fresh uuid id: an undo keeps entries in the index, and dropping the redo branch takes
    a record that adds a new id, so another writer's work never reads as ours.
    """
    current = load_json_object(index_path)
    if current != index_before and current not in own_indexes:
        return False
    ids = set(own_entry_ids)
    if current != index_before or ids:
        rollback_history(index_path, index_before, ids)
    return True


def commit_landed(project: EpisodeProject, revision_before: FileRevision | None) -> bool | None:
    """Whether the project file was replaced since ``revision_before`` (``None``: unknown).

    For cleanup after a failed commit; call under ``project_commit_lock``. ``None`` when the
    file cannot be stat'ed: callers then restore only the in-memory history and leave
    ``history/index.json`` and its snapshots on disk (an orphaned snapshot is harmless; a
    deleted one that the saved file references breaks undo).
    """
    try:
        return project_file_revision(project) != revision_before
    except OSError:
        log.warning("Could not stat the project file after a failed commit", exc_info=True)
        return None


class ProjectStore:
    """Single API for loading and committing episode.project.json."""

    def __init__(self, project_path: Path | str) -> None:
        self.project_path = Path(project_path).expanduser().resolve()
        if self.project_path.is_dir():
            self.project_path = project_file_path(self.project_path)

    def load(self) -> EpisodeProject:
        project = load_project(self.project_path)
        self.adopt_history_index(project)
        return project

    def commit(self, project: EpisodeProject) -> Path:
        with project_commit_lock(project):
            self._sync_history_index_to_project(project)
            path = save_project(project, self.project_path)
            self._mirror_transcript_cache(project)
            return path

    def reload(self, project: EpisodeProject) -> EpisodeProject:
        loaded = self.load()
        project.__dict__.update(loaded.model_dump())
        return project

    def adopt_history_index(self, project: EpisodeProject) -> bool:
        """Fill an empty in-memory history from ``history/index.json`` if one exists.

        A corrupt index raises ``ValueError``.
        """
        if not project.history.is_empty():
            return False
        history = read_history_index(history_index_path(project))
        if history is None:
            return False
        project.history = history
        return True

    def _sync_history_index_to_project(self, project: EpisodeProject) -> None:
        """Mirror history to ``history/index.json``; an empty one adopts the index instead."""
        if self.adopt_history_index(project):
            return
        index_path = history_index_path(project)
        if index_path.parent.exists() or not project.history.is_empty():
            index_path.parent.mkdir(parents=True, exist_ok=True)
            write_json_atomic(index_path, project.history.model_dump(mode="json"))

    def _mirror_transcript_cache(self, project: EpisodeProject) -> None:
        """Write-through optional caches; canonical data lives in episode.project.json."""
        combined = project.transcript_data.combined
        if combined and combined.utterances:
            out = project.transcripts_dir() / "combined.json"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(combined.model_dump_json(indent=2, by_alias=True), encoding="utf-8")
        for transcript in project.transcript_data.per_track:
            if not transcript.words:
                continue
            cache = project.transcripts_dir() / f"{transcript.track_id}.json"
            cache.write_text(transcript.model_dump_json(indent=2, by_alias=True), encoding="utf-8")
