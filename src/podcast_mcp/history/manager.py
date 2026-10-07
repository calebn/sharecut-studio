from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from podcast_mcp.history.rollback import rolled_back_on_failure, take_history_checkpoint
from podcast_mcp.models.episode import EpisodeProject
from podcast_mcp.models.history import HistoryEntry, ProjectHistory, ProjectStateSnapshot
from podcast_mcp.models.project_format import apply_editable_snapshot
from podcast_mcp.project_store import (
    ProjectStore,
    history_index_path,
    history_snapshot_path,
    read_history_snapshot,
    snapshot_from_project,
    snapshots_equal,
)
from podcast_mcp.util.atomic_json import write_json_atomic
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.project_state import project_commit_lock

EDITABLE_FIELDS: tuple[str, ...] = tuple(ProjectStateSnapshot.model_fields.keys())


def apply_snapshot_to_project(
    project: EpisodeProject,
    snapshot: ProjectStateSnapshot,
) -> None:
    apply_editable_snapshot(project, snapshot.model_dump())


def write_snapshot(project: EpisodeProject, snapshot: ProjectStateSnapshot, entry_id: str) -> str:
    """Write ``snapshot`` as history entry ``entry_id``; return its workspace-relative path."""
    path = history_snapshot_path(history_index_path(project), entry_id)
    rel = path.relative_to(project.workspace_path()).as_posix()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(snapshot.model_dump_json(indent=2, by_alias=True), encoding="utf-8")
    return rel


HISTORY_STALE_CODE = "history_stale"


class StaleHistoryError(CodedError):
    """An undo or redo named the head entry it expected, and history has moved since."""

    def __init__(self, action: Literal["undo", "redo"]) -> None:
        done = {"undo": "undone", "redo": "redone"}[action]
        super().__init__(
            f"Did not {action}: the project changed after this {action} was requested, "
            f"so nothing was {done}. Review the latest change, then {action} again "
            "if you still mean to.",
            code=HISTORY_STALE_CODE,
        )


def _require_head(
    history: ProjectHistory, action: Literal["undo", "redo"], expected_head_id: str | None
) -> None:
    if expected_head_id is not None and history.head_id() != expected_head_id:
        raise StaleHistoryError(action)


@dataclass
class HistoryStatus:
    cursor: int
    total: int
    can_undo: bool
    can_redo: bool
    current_label: str | None
    head_id: str | None


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

    def _read_snapshot(
        self,
        project: EpisodeProject,
        entry: HistoryEntry,
    ) -> ProjectStateSnapshot:
        return read_history_snapshot(project, entry)

    def record(
        self,
        project: EpisodeProject,
        label: str,
        *,
        force: bool = False,
        operation: str | None = None,
        params: dict | None = None,
        snapshot: ProjectStateSnapshot | None = None,
    ) -> HistoryEntry:
        with project_commit_lock(project):
            return self._record_locked(
                project, label, force=force, operation=operation, params=params, snapshot=snapshot
            )

    def undo(
        self, project: EpisodeProject, *, expected_head_id: str | None = None
    ) -> HistoryStatus:
        """Step back one entry; with ``expected_head_id``, only while that entry is the head."""
        with project_commit_lock(project):
            return self._undo_locked(project, expected_head_id)

    def redo(
        self, project: EpisodeProject, *, expected_head_id: str | None = None
    ) -> HistoryStatus:
        """Step forward one entry; with ``expected_head_id``, only while that entry is the head."""
        with project_commit_lock(project):
            return self._redo_locked(project, expected_head_id)

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
        snapshot: ProjectStateSnapshot | None = None,
    ) -> HistoryEntry:
        history = self._load_index(project)
        snap = snapshot if snapshot is not None else snapshot_from_project(project)

        if not force and history.cursor >= 0 and history.entries:
            current = self._read_snapshot(project, history.entries[history.cursor])
            if snapshots_equal(current, snap):
                return history.entries[history.cursor]

        entry_id = uuid.uuid4().hex[:12]
        rel = write_snapshot(project, snap, entry_id)
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

    def _undo_locked(self, project: EpisodeProject, expected_head_id: str | None) -> HistoryStatus:
        history = self._load_index(project)
        _require_head(history, "undo", expected_head_id)
        if not history.can_undo():
            raise ValueError("Nothing to undo")
        history.cursor -= 1
        entry = history.entries[history.cursor]
        apply_snapshot_to_project(project, self._read_snapshot(project, entry))
        project.history = history
        self._save_index(project)
        self._store.commit(project)
        return self.status(project)

    def _redo_locked(self, project: EpisodeProject, expected_head_id: str | None) -> HistoryStatus:
        history = self._load_index(project)
        _require_head(history, "redo", expected_head_id)
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
            head_id=history.head_id(),
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

    A failure rolls the new entry back (``history.rollback.rolled_back_on_failure``).
    """
    # record() and store.commit() take project_commit_lock again inside this hold; that
    # nests only because both locks are re-entrant per thread
    # (tests/test_project_commit_lock.py::test_lock_is_reentrant_and_shared_per_workspace).
    with project_commit_lock(project):
        checkpoint = take_history_checkpoint(store, project)
        with rolled_back_on_failure(project, checkpoint):
            entry = HistoryManager(store.project_path).record(project, label, force=force)
            checkpoint.start_commit(project)
            store.commit(project)
        return entry
