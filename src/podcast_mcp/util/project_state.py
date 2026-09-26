"""In-process coordination for readers of mutable episode state."""

from __future__ import annotations

import functools
import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from threading import Lock, RLock
from typing import Concatenate, ParamSpec, TypeVar

from filelock import Timeout

from podcast_mcp.models import EpisodeProject, project_file_path
from podcast_mcp.util.file_locks import shared_file_lock

_registry_lock = Lock()
_locks: dict[str, RLock] = {}

FileRevision = tuple[int, int, int, int]

PROJECT_COMMIT_LOCK_TIMEOUT_SEC = 30.0
RENDER_LOCK_TIMEOUT_SEC = 3600.0

log = logging.getLogger(__name__)
_P = ParamSpec("_P")
_R = TypeVar("_R")


def _workspace_key(project: EpisodeProject) -> str:
    return str(project.workspace_path().resolve())


def project_commit_lock_path(project: EpisodeProject) -> Path:
    """Lock file for cross-process commits (not under ``history/``: that dir arms index writes)."""
    return project.workspace_path().resolve() / "artifacts" / "episode.project.json.lock"


def render_lock_path(project: EpisodeProject) -> Path:
    """Lock file serializing writers of stems, ``premix.wav`` and ``mastered.wav`` (#482)."""
    return project.workspace_path().resolve() / "artifacts" / "render.lock"


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

    Lock order: the in-process ``project_state_lock`` RLock first, then the shared
    per-workspace file lock (re-entrant per thread). Never take the file lock without
    the state lock. Take it before any sqlite write transaction (``SyncStore.write_transaction``
    / ``append_and_apply`` / ``BEGIN IMMEDIATE``), never while one is open: the order is
    project lock, then sqlite write lock, or two processes can deadlock until a timeout.
    ``ProjectWorkspace.transaction()`` holds it from the reload through the
    commit, so read-modify-write is serialized across processes (#213).
    Raises ``filelock.Timeout`` after ``PROJECT_COMMIT_LOCK_TIMEOUT_SEC``.
    """
    with project_state_lock(project):
        file_lock = shared_file_lock(
            project_commit_lock_path(project), timeout=PROJECT_COMMIT_LOCK_TIMEOUT_SEC
        )
        with file_lock.acquire(timeout=PROJECT_COMMIT_LOCK_TIMEOUT_SEC):
            yield


@contextmanager
def render_lock(project: EpisodeProject) -> Iterator[None]:
    """Serialize render writers of this workspace across threads and processes (#356, #482).

    Held around every write of ``artifacts/tracks/<id>.wav`` + ``.hash``, ``premix.wav`` +
    ``premix.hash`` and ``mastered.wav`` + ``mastered.hash`` (stem render, mix, master,
    export, bleed-mute rewrite). Re-entrant per thread; stem worker threads of the holder
    do not take it. Readers never take it. Lock order: take it before ``project_state_lock`` /
    ``project_commit_lock``, never while holding them (unless this thread already holds it),
    or a render that snapshots the project deadlocks against a mutation waiting for it.
    Raises ``filelock.Timeout`` after ``RENDER_LOCK_TIMEOUT_SEC``.
    """
    lock = shared_file_lock(render_lock_path(project), timeout=RENDER_LOCK_TIMEOUT_SEC)
    try:
        lock.acquire(timeout=0)
    except Timeout:
        log.info("waiting for another render of %s", project.workspace_path())
        lock.acquire(timeout=RENDER_LOCK_TIMEOUT_SEC)
    try:
        yield
    finally:
        lock.release()


def with_render_lock(
    fn: Callable[Concatenate[EpisodeProject, _P], _R],
) -> Callable[Concatenate[EpisodeProject, _P], _R]:
    """Decorator: hold ``render_lock`` of the first argument (the project) around ``fn``."""

    @functools.wraps(fn)
    def wrapper(project: EpisodeProject, /, *args: _P.args, **kwargs: _P.kwargs) -> _R:
        with render_lock(project):
            return fn(project, *args, **kwargs)

    return wrapper
