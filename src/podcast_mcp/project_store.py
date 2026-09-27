from __future__ import annotations

import logging
import re
from collections.abc import Collection, Iterable
from pathlib import Path
from typing import Any

from podcast_mcp.models import (
    EpisodeProject,
    TranscriptsSection,
    load_project,
    project_file_path,
    save_project,
)
from podcast_mcp.models.history import ProjectHistory, ProjectStateSnapshot
from podcast_mcp.models.project_format import snapshot_editable_state
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic
from podcast_mcp.util.project_state import FileRevision, project_commit_lock, project_file_revision

log = logging.getLogger(__name__)
HISTORY_ENTRY_LIMIT = 400
_GENERATED_SNAPSHOT_ID = re.compile(r"[0-9a-f]{12}\Z")


def history_index_path(project: EpisodeProject) -> Path:
    """``history/index.json`` in ``project``'s workspace."""
    return project.history_dir() / "index.json"


def history_snapshots_dir(index_path: Path) -> Path:
    """Directory holding the history snapshot files beside ``index_path``."""
    return index_path.parent / "snapshots"


def history_snapshot_path(index_path: Path, entry_id: str) -> Path:
    """Snapshot file of history entry ``entry_id`` (``snapshots/<id>.json``)."""
    return history_snapshots_dir(index_path) / f"{entry_id}.json"


def snapshot_from_project(project: EpisodeProject) -> ProjectStateSnapshot:
    """``project``'s editable state as a history snapshot (what undo/redo restores)."""
    return ProjectStateSnapshot.model_validate(snapshot_editable_state(project))


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


def history_matches_project(project: EpisodeProject, history: ProjectHistory) -> bool:
    """Whether ``history``'s current entry snapshots ``project``'s editable state.

    Every commit that records history saves the state its current entry snapshots, so an
    index whose current entry holds other state was written by a commit that never landed
    (for example a process killed between ``record(after)`` and ``save_project``, #576). No
    current entry, or a missing or unreadable snapshot, does not match.
    """
    if not 0 <= history.cursor < len(history.entries):
        return False
    snapshot_path = project.workspace_path() / history.entries[history.cursor].snapshot_file
    try:
        data = load_json_object(snapshot_path)
        saved = None if data is None else ProjectStateSnapshot.model_validate(data)
    except ValueError:  # includes pydantic.ValidationError
        saved = None
    if saved is None:
        log.warning("History snapshot %s is missing or unreadable", snapshot_path)
        return False
    return saved == snapshot_from_project(project)


class ProjectStore:
    """Single API for loading and committing episode.project.json."""

    def __init__(self, project_path: Path | str) -> None:
        self.project_path = Path(project_path).expanduser().resolve()
        if self.project_path.is_dir():
            self.project_path = project_file_path(self.project_path)
        self._mirrored_transcripts: TranscriptsSection | None = None
        self._mirrored_cache_signatures: dict[Path, tuple[int, ...]] | None = None

    def load(self) -> EpisodeProject:
        project = load_project(self.project_path)
        self.adopt_history_index(project)
        return project

    def commit(self, project: EpisodeProject) -> Path:
        with project_commit_lock(project):
            try:
                self.adopt_history_index(project)
            except ValueError:
                log.warning("Repairing invalid history index from canonical project history")
            pruned_ids = self._trim_history(project)
            self._sync_history_index_to_project(project)
            path = save_project(project, self.project_path)
            self._remove_pruned_snapshots(project, pruned_ids)
            self._mirror_transcript_cache(project)
            return path

    def _trim_history(self, project: EpisodeProject) -> set[str]:
        """Trim only old undo entries; retain all redo and complete edit pairs."""
        history = project.history
        excess = len(history.entries) - HISTORY_ENTRY_LIMIT
        if excess <= 0:
            return set()
        max_remove = min(excess, history.cursor)
        start = 0
        while start < max_remove:
            next_start = start + 1
            if (
                history.entries[start].label.startswith("before ")
                and next_start < len(history.entries)
                and history.entries[next_start].label == f"after {history.entries[start].label[7:]}"
            ):
                next_start += 1
            if next_start > max_remove:
                break
            start = next_start
        if start:
            pruned = {entry.id for entry in history.entries[:start]}
            history.entries = history.entries[start:]
            history.cursor -= start
            return pruned
        return set()

    def _remove_pruned_snapshots(self, project: EpisodeProject, pruned_ids: set[str]) -> None:
        """Only collect snapshots after the canonical project replacement has landed."""
        index_path = history_index_path(project)
        snapshots_dir = history_snapshots_dir(index_path).resolve()
        if snapshots_dir != project.workspace_path() / "history" / "snapshots":
            log.warning(
                "Skipping pruned history snapshots outside project workspace: %s", snapshots_dir
            )
            return
        for entry_id in pruned_ids:
            if _GENERATED_SNAPSHOT_ID.fullmatch(entry_id) is None:
                log.warning("Skipping unsafe pruned history snapshot id %r", entry_id)
                continue
            path = history_snapshot_path(index_path, entry_id)
            if path.resolve().parent != snapshots_dir:
                log.warning("Skipping pruned history snapshot outside %s: %s", snapshots_dir, path)
                continue
            path.unlink(missing_ok=True)

    def reload(self, project: EpisodeProject) -> EpisodeProject:
        loaded = self.load()
        project.__dict__.update(loaded.model_dump())
        return project

    def adopt_history_index(self, project: EpisodeProject) -> bool:
        """Fill an empty in-memory history from ``history/index.json`` when it matches.

        The index is adopted only when its current entry snapshots ``project``'s editable
        state (``history_matches_project``). An index a commit left ahead of the saved
        project before dying is ignored with a warning, and the next commit rewrites it
        from the project's history (#576). A corrupt index raises ``ValueError``.
        """
        if not project.history.is_empty():
            return False
        index_path = history_index_path(project)
        history = read_history_index(index_path)
        if history is None or history.is_empty():
            return False
        if not history_matches_project(project, history):
            log.warning(
                "Not adopting %s: its current entry does not match the project "
                "(a commit that never landed); the next commit rewrites it",
                index_path,
            )
            return False
        project.history = history
        return True

    def _sync_history_index_to_project(self, project: EpisodeProject) -> None:
        """Mirror history to ``history/index.json``; an empty one adopts the index instead."""
        try:
            if self.adopt_history_index(project):
                return
        except ValueError:
            log.warning("Repairing invalid history index from canonical project history")
        index_path = history_index_path(project)
        if index_path.parent.exists() or not project.history.is_empty():
            index_path.parent.mkdir(parents=True, exist_ok=True)
            desired = project.history.model_dump(mode="json")
            try:
                current = load_json_object(index_path)
            except ValueError:
                current = None
            if current != desired:
                write_json_atomic(index_path, desired)

    @staticmethod
    def _write_cache_if_changed(path: Path, content: bytes) -> None:
        try:
            if path.read_bytes() == content:
                return
        except FileNotFoundError:
            pass
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    @staticmethod
    def _transcript_cache_paths(project: EpisodeProject) -> list[Path]:
        directory = project.transcripts_dir()
        paths = []
        combined = project.transcript_data.combined
        if combined and combined.utterances:
            paths.append(directory / "combined.json")
        paths.extend(
            directory / f"{transcript.track_id}.json"
            for transcript in project.transcript_data.per_track
            if transcript.words
        )
        return paths

    @staticmethod
    def _cache_signatures(paths: list[Path]) -> dict[Path, tuple[int, ...]] | None:
        signatures: dict[Path, tuple[int, ...]] = {}
        for path in paths:
            try:
                stat = path.stat()
            except OSError:
                return None
            signatures[path] = (
                stat.st_dev,
                stat.st_ino,
                stat.st_size,
                stat.st_mtime_ns,
                stat.st_ctime_ns,
            )
        return signatures

    def _mirror_transcript_cache(self, project: EpisodeProject) -> None:
        """Write-through optional caches; canonical data lives in episode.project.json."""
        paths = self._transcript_cache_paths(project)
        if (
            self._mirrored_transcripts is not None
            and project.transcript_data == self._mirrored_transcripts
            and self._cache_signatures(paths) == self._mirrored_cache_signatures
        ):
            return
        combined = project.transcript_data.combined
        if combined and combined.utterances:
            out = project.transcripts_dir() / "combined.json"
            self._write_cache_if_changed(
                out, combined.model_dump_json(indent=2, by_alias=True).encode("utf-8")
            )
        for transcript in project.transcript_data.per_track:
            if not transcript.words:
                continue
            cache = project.transcripts_dir() / f"{transcript.track_id}.json"
            self._write_cache_if_changed(
                cache, transcript.model_dump_json(indent=2, by_alias=True).encode("utf-8")
            )
        signatures = self._cache_signatures(paths)
        self._mirrored_transcripts = (
            project.transcript_data.model_copy(deep=True) if signatures is not None else None
        )
        self._mirrored_cache_signatures = signatures
