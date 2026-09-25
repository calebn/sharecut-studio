from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

from podcast_mcp.history import HistoryManager, run_mutation
from podcast_mcp.models import EpisodeProject
from podcast_mcp.project_io import open_project, resolve_project_path
from podcast_mcp.project_store import ProjectStore
from podcast_mcp.util.project_state import FileRevision, file_revision, project_state_lock

T = TypeVar("T")


class ProjectWorkspace:
    def __init__(self, path: Path, project: EpisodeProject) -> None:
        self.path = path
        self.project = project
        self._store = ProjectStore(path)
        self._loaded_file_signature: FileRevision | None = None

    @classmethod
    def open(cls, project_path: Path | str) -> ProjectWorkspace:
        path = resolve_project_path(project_path)
        before = file_revision(path)
        _, project = open_project(path)
        ws = cls(path, project)
        signature = file_revision(path)
        if signature == before:
            ws._loaded_file_signature = signature
        return ws

    def reload(self) -> EpisodeProject:
        with project_state_lock(self.project):
            signature = file_revision(self.path)
            if signature == self._loaded_file_signature:
                return self.project
            self.project = self._store.load()
            self._loaded_file_signature = (
                signature if file_revision(self.path) == signature else None
            )
            return self.project

    def save(self) -> None:
        with project_state_lock(self.project):
            self._store.commit(self.project)
            # A separate process may replace the file as this commit finishes.
            # Re-read once before trusting a revision for this in-memory model.
            self._loaded_file_signature = None

    def mutate(
        self,
        label_before: str,
        label_after: str,
        fn: Callable[[EpisodeProject], T],
        *,
        operation: str | None = None,
        params: dict | None = None,
    ) -> T:
        with project_state_lock(self.project):
            try:
                return run_mutation(
                    self.path,
                    self.project,
                    label_before,
                    label_after,
                    fn,
                    operation=operation,
                    params=params,
                )
            finally:
                # Even a failed save may have changed the in-memory project,
                # so the next reload reads the file instead of trusting it.
                self._loaded_file_signature = None

    def record_snapshot(self, label: str, *, force: bool = False) -> str:
        entry = HistoryManager(self.path).record(self.project, label, force=force)
        self.save()
        return f"{entry.id}: {entry.label}"

    @staticmethod
    def create(workspace_dir: Path | str, name: str = "episode") -> ProjectWorkspace:
        workspace = Path(workspace_dir).expanduser().resolve()
        project = EpisodeProject.create(name, str(workspace))
        project.ensure_dirs()
        path = resolve_project_path(workspace)
        store = ProjectStore(path)
        store.commit(project)
        loaded = store.load()
        HistoryManager(path).record(loaded, "initial", force=True)
        store.commit(loaded)
        return ProjectWorkspace(path, loaded)
