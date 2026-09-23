from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from pathlib import Path

from podcast_mcp.models.episode import EpisodeProject
from podcast_mcp.models.history import HistoryEntry, ProjectHistory, ProjectStateSnapshot
from podcast_mcp.models.project_format import apply_editable_snapshot, snapshot_editable_state
from podcast_mcp.project_store import ProjectStore
from podcast_mcp.util.atomic_json import write_json_atomic

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
        index_path = project.workspace_path() / "history" / "index.json"
        index_path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(index_path, history.model_dump(mode="json"))

    def _write_snapshot(
        self,
        project: EpisodeProject,
        snapshot: ProjectStateSnapshot,
        entry_id: str,
    ) -> str:
        rel = f"history/snapshots/{entry_id}.json"
        path = project.workspace_path() / rel
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

    def undo(self, project: EpisodeProject) -> HistoryStatus:
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

    def redo(self, project: EpisodeProject) -> HistoryStatus:
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

    def goto(self, project: EpisodeProject, index: int) -> HistoryStatus:
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
    project = store.load()
    mgr = HistoryManager(project_path)
    entry = mgr.record(project, label, force=force)
    store.commit(project)
    return entry
