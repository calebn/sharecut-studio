from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from pathlib import Path

from podcast_mcp.history.rollback import roll_back_history, take_history_checkpoint
from podcast_mcp.models.episode import EpisodeProject
from podcast_mcp.models.history import HistoryEntry, ProjectHistory, ProjectStateSnapshot
from podcast_mcp.models.project_format import apply_editable_snapshot, snapshot_editable_state
from podcast_mcp.project_store import ProjectStore, history_index_path, history_snapshot_path
from podcast_mcp.util.atomic_json import write_json_atomic
from podcast_mcp.util.project_state import project_commit_lock

EDITABLE_FIELDS: tuple[str, ...] = tuple(ProjectStateSnapshot.model_fields.keys())


def snapshot_from_project(project: EpisodeProject) -> ProjectStateSnapshot:
    raw = snapshot_editable_state(project)
    return ProjectStateSnapshot.model_validate(raw)


def apply_snapshot_to_project(
    project: EpisodeProject,
    snapshot: ProjectStateSnapshot,
) -> None:
    apply_editable_snapshot(project, snapshot.model_dump())


@dataclass
class HistoryStatus:
    cursor: int
    total: int
    can_undo: bool
    can_redo: bool
    current_label: str | None


class HistoryManager:
    def __init__(self, project_path: Path) -> None:
        self.project_path = project_path.expanduser().resolve()
        self._store = ProjectStore(self.project_path)

    def _load_index(self, project: EpisodeProject) -> ProjectHistory:
        self._store.adopt_history_index(project)
        return project.history

    def _save_index(self, project: EpisodeProject) -> None:
        history = self._load_index(project)
        index_path = history_index_path(project)
        index_path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(index_path, history.model_dump(mode="json"))

    def _write_snapshot(
        self,
        project: EpisodeProject,
        snapshot: ProjectStateSnapshot,
        entry_id: str,
    ) -> str:
        path = history_snapshot_path(history_index_path(project), entry_id)
        rel = path.relative_to(project.workspace_path()).as_posix()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(snapshot.model_dump_json(indent=2, by_alias=True), encoding="utf-8")
        return rel

    def _read_snapshot(
        self,
        project: EpisodeProject,
        entry: HistoryEntry,
    ) -> ProjectStateSnapshot:
        path = project.workspace_path() / entry.snapshot_file
        data = json.loads(path.read_text(encoding="utf-8"))
        if "timeline" not in data:
            raise ValueError(
                f"History snapshot {entry.snapshot_file} is not v2 format "
                "(missing timeline section)."
            )
        return ProjectStateSnapshot.model_validate(data)

    def record(
        self,
        project: EpisodeProject,
        label: str,
        *,
        force: bool = False,
        operation: str | None = None,
        params: dict | None = None,
    ) -> HistoryEntry:
        with project_commit_lock(project):
            return self._record_locked(
                project, label, force=force, operation=operation, params=params
            )

    def undo(self, project: EpisodeProject) -> HistoryStatus:
        with project_commit_lock(project):
            return self._undo_locked(project)

    def redo(self, project: EpisodeProject) -> HistoryStatus:
        with project_commit_lock(project):
            return self._redo_locked(project)

    def goto(self, project: EpisodeProject, index: int) -> HistoryStatus:
        with project_commit_lock(project):
            return self._goto_locked(project, index)

    # record/undo/redo/goto above take project_commit_lock; each ``_X_locked`` body
    # runs while that lock is held. Call the public methods, not these.
    def _record_locked(
        self,
        project: EpisodeProject,
        label: str,
        *,
        force: bool = False,
        operation: str | None = None,
        params: dict | None = None,
    ) -> HistoryEntry:
        history = self._load_index(project)
        snap = snapshot_from_project(project)

        if not force and history.cursor >= 0 and history.entries:
            current = self._read_snapshot(project, history.entries[history.cursor])
            if current.model_dump() == snap.model_dump():
                return history.entries[history.cursor]

        entry_id = uuid.uuid4().hex[:12]
        rel = self._write_snapshot(project, snap, entry_id)
        entry = HistoryEntry(
            id=entry_id,
            label=label,
            snapshot_file=rel,
            operation=operation,
            params=params,
        )

        if history.cursor < len(history.entries) - 1:
            history.entries = history.entries[: history.cursor + 1]

        history.entries.append(entry)
        history.cursor = len(history.entries) - 1
        project.history = history
        self._save_index(project)
        return entry

    def _undo_locked(self, project: EpisodeProject) -> HistoryStatus:
        history = self._load_index(project)
        if not history.can_undo():
            raise ValueError("Nothing to undo")
        history.cursor -= 1
        entry = history.entries[history.cursor]
        apply_snapshot_to_project(project, self._read_snapshot(project, entry))
        project.history = history
        self._save_index(project)
        self._store.commit(project)
        return self.status(project)

    def _redo_locked(self, project: EpisodeProject) -> HistoryStatus:
        history = self._load_index(project)
        if not history.can_redo():
            raise ValueError("Nothing to redo")
        history.cursor += 1
        entry = history.entries[history.cursor]
        apply_snapshot_to_project(project, self._read_snapshot(project, entry))
        project.history = history
        self._save_index(project)
        self._store.commit(project)
        return self.status(project)

    def _goto_locked(self, project: EpisodeProject, index: int) -> HistoryStatus:
        history = self._load_index(project)
        if index < 0 or index >= len(history.entries):
            raise ValueError(f"History index out of range: {index}")
        history.cursor = index
        entry = history.entries[history.cursor]
        apply_snapshot_to_project(project, self._read_snapshot(project, entry))
        project.history = history
        self._save_index(project)
        self._store.commit(project)
        return self.status(project)

    def status(self, project: EpisodeProject) -> HistoryStatus:
        history = self._load_index(project)
        label = None
        if 0 <= history.cursor < len(history.entries):
            label = history.entries[history.cursor].label
        return HistoryStatus(
            cursor=history.cursor,
            total=len(history.entries),
            can_undo=history.can_undo(),
            can_redo=history.can_redo(),
            current_label=label,
        )

    def list_entries(self, project: EpisodeProject) -> list[HistoryEntry]:
        return list(self._load_index(project).entries)


def record_if_changed(
    project_path: Path,
    label: str,
    *,
    force: bool = False,
) -> HistoryEntry:
    store = ProjectStore(project_path)
    return record_and_commit(store, store.load(), label, force=force)


def record_and_commit(
    store: ProjectStore, project: EpisodeProject, label: str, *, force: bool = False
) -> HistoryEntry:
    """Record ``label`` and commit ``project`` as one locked step.

    A failure rolls the new entry back (``history.rollback.roll_back_history``).
    """
    with project_commit_lock(project):
        checkpoint = take_history_checkpoint(store, project)
        try:
            checkpoint.start_commit(project)
            entry = HistoryManager(store.project_path).record(project, label, force=force)
            store.commit(project)
        except BaseException:
            roll_back_history(project, checkpoint)
            raise
        return entry
