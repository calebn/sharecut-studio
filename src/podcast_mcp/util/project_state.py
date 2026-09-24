"""In-process coordination for readers of mutable episode state."""

from __future__ import annotations

from threading import Lock, RLock
from weakref import ref

from podcast_mcp.models import EpisodeProject

_registry_lock = Lock()
_locks: dict[int, tuple[ref[EpisodeProject], RLock]] = {}


def project_state_lock(project: EpisodeProject) -> RLock:
    """Return the lock shared by mutations and snapshots of this model instance."""
    key = id(project)
    with _registry_lock:
        entry = _locks.get(key)
        if entry is not None and entry[0]() is project:
            return entry[1]

        def discard(dead: ref[EpisodeProject]) -> None:
            with _registry_lock:
                current = _locks.get(key)
                if current is not None and current[0] is dead:
                    del _locks[key]

        lock = RLock()
        _locks[key] = (ref(project, discard), lock)
        return lock


def snapshot_project(project: EpisodeProject) -> EpisodeProject:
    """Copy a consistent project state before asynchronous render work."""
    with project_state_lock(project):
        return project.model_copy(deep=True)
