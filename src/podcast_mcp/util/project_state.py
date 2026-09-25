"""In-process coordination for readers of mutable episode state."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from threading import Lock, RLock

from filelock import FileLock

from podcast_mcp.models import EpisodeProject, project_file_path

_registry_lock = Lock()
_locks: dict[str, RLock] = {}

_file_locks: dict[str, FileLock] = {}

FileRevision = tuple[int, int, int, int]

PROJECT_COMMIT_LOCK_TIMEOUT_SEC = 30.0


def _workspace_key(project: EpisodeProject) -> str:
    return str(project.workspace_path().resolve())


def project_commit_lock_path(project: EpisodeProject) -> Path:
    """Lock file for cross-process commits (not under ``history/``: that dir arms index writes)."""
    return project.workspace_path().resolve() / "artifacts" / "episode.project.json.lock"


def project_state_lock(project: EpisodeProject) -> RLock:
    """Return the in-process lock shared by this workspace's mutations and reads."""
    key = _workspace_key(project)
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


def file_revision(path: Path) -> FileRevision:
    """Identity of a file that may be atomically replaced."""
    stat = path.stat()
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns


def project_file_revision(project: EpisodeProject) -> FileRevision | None:
    """Identity of the atomically replaced project JSON, if it exists."""
    try:
        return file_revision(project_file_path(project.workspace_path()))
    except FileNotFoundError:
        return None


def snapshot_project_with_revision(
    project: EpisodeProject,
) -> tuple[EpisodeProject, tuple[int, int, int, int] | None]:
    """Capture in-memory render state and the workspace's durable revision together."""
    with project_state_lock(project):
        return project.model_copy(deep=True), project_file_revision(project)


@contextmanager
def project_commit_lock(project: EpisodeProject) -> Iterator[None]:
    """Serialize history-index + project-JSON commits across threads and processes.

    Takes the in-process state lock first, then a re-entrant per-workspace file lock.
    """
    key = _workspace_key(project)
    with project_state_lock(project):
        with _registry_lock:
            file_lock = _file_locks.get(key)
            if file_lock is None:
                path = project_commit_lock_path(project)
                path.parent.mkdir(parents=True, exist_ok=True)
                file_lock = FileLock(str(path), timeout=PROJECT_COMMIT_LOCK_TIMEOUT_SEC)
                _file_locks[key] = file_lock
        with file_lock:
            yield
