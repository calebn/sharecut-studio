"""In-process coordination for readers of mutable episode state."""

from __future__ import annotations

from threading import Lock, RLock

from podcast_mcp.models import EpisodeProject

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
