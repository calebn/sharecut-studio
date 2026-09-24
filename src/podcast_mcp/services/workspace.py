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
        self._loaded_file_signature: tuple[int, int, int] | None = None

    def _file_signature(self) -> tuple[int, int, int]:
        stat = self.path.stat()
        return stat.st_mtime_ns, stat.st_size, stat.st_ino

    @classmethod
    def open(cls, project_path: Path | str) -> ProjectWorkspace:
        path = resolve_project_path(project_path)
        before = path.stat()
        _, project = open_project(path)
        ws = cls(path, project)
        signature = ws._file_signature()
        if signature == (before.st_mtime_ns, before.st_size, before.st_ino):
            ws._loaded_file_signature = signature
        return ws

    def reload(self) -> EpisodeProject:
        signature = self._file_signature()
        if signature == self._loaded_file_signature:
            return self.project
        self.project = self._store.load()
        self._loaded_file_signature = signature if self._file_signature() == signature else None
        return self.project

    def save(self) -> None:
        self._store.commit(self.project)
        self._loaded_file_signature = self._file_signature()

    def mutate(
        self,
        label_before: str,
        label_after: str,
        fn: Callable[[EpisodeProject], T],
        *,
        operation: str | None = None,
        params: dict | None = None,
    ) -> T:
        result = run_mutation(
            self.path,
            self.project,
            label_before,
            label_after,
            fn,
            operation=operation,
            params=params,
        )
        self._loaded_file_signature = self._file_signature()
        return result

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
