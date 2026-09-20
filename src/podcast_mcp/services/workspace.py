from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

from podcast_mcp.history import HistoryManager, run_mutation
from podcast_mcp.models import EpisodeProject
from podcast_mcp.project_io import open_project, resolve_project_path
from podcast_mcp.project_store import ProjectStore

T = TypeVar("T")


class ProjectWorkspace:
    def __init__(self, path: Path, project: EpisodeProject) -> None:
        self.path = path
        self.project = project
        self._store = ProjectStore(path)

    @classmethod
    def open(cls, project_path: Path | str) -> ProjectWorkspace:
        path, project = open_project(project_path)
        return cls(path, project)

    def reload(self) -> EpisodeProject:
        self.project = self._store.load()
        return self.project

    def save(self) -> None:
        self._store.commit(self.project)

    def mutate(
        self,
        label_before: str,
        label_after: str,
        fn: Callable[[EpisodeProject], T],
        *,
        operation: str | None = None,
        params: dict | None = None,
    ) -> T:
        return run_mutation(
            self.path,
            self.project,
            label_before,
            label_after,
            fn,
            operation=operation,
            params=params,
        )

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
