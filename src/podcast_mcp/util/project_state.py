"""In-process coordination for readers of mutable episode state."""

from __future__ import annotations

from threading import Lock, RLock

from podcast_mcp.models import EpisodeProject, project_file_path

_registry_lock = Lock()
_locks: dict[str, RLock] = {}


def project_state_lock(project: EpisodeProject) -> RLock:
    """Return the in-process lock shared by this workspace's mutations and reads."""
    key = str(project.workspace_path().resolve())
    with _registry_lock:
        lock = _locks.get(key)
        if lock is None:
            lock = RLock()
            _locks[key] = lock
        return lock


def snapshot_project(project: EpisodeProject) -> EpisodeProject:
    """Copy a consistent project state before asynchronous render work."""
    with project_state_lock(project):
        return project.model_copy(deep=True)


def project_file_revision(project: EpisodeProject) -> tuple[int, int, int, int] | None:
    """Identity of the atomically replaced project JSON, if it exists."""
    path = project_file_path(project.workspace_path())
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns


def snapshot_project_with_revision(
    project: EpisodeProject,
) -> tuple[EpisodeProject, tuple[int, int, int, int] | None]:
    """Capture in-memory render state and the workspace's durable revision together."""
    with project_state_lock(project):
        return project.model_copy(deep=True), project_file_revision(project)
