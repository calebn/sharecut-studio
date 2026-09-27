"""In-process coordination for readers of mutable episode state."""

from __future__ import annotations

import functools
import logging
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from threading import RLock
from typing import Concatenate, ParamSpec, TypeVar

from filelock import Timeout

from podcast_mcp.models import EpisodeProject, project_file_path, workspace_artifacts_dir
from podcast_mcp.util.file_locks import shared_file_lock
from podcast_mcp.util.keyed_lock import KeyedLocks
from podcast_mcp.util.progress import CancelledProgress

_locks: KeyedLocks[str, RLock] = KeyedLocks(RLock)

FileRevision = tuple[int, int, int, int]

PROJECT_COMMIT_LOCK_TIMEOUT_SEC = 30.0
RENDER_LOCK_TIMEOUT_SEC = 3600.0
# MCP tool calls cannot be cancelled: they wait this long for the render lock, then RenderBusyError.
REQUEST_RENDER_LOCK_TIMEOUT_SEC = 30.0
RENDER_LOCK_POLL_SEC = 0.5

log = logging.getLogger(__name__)
_P = ParamSpec("_P")
_R = TypeVar("_R")

# (private step copy, live project it was copied from) for the running pipeline step (#357).
_step_copy: ContextVar[tuple[EpisodeProject, EpisodeProject] | None] = ContextVar(
    "pipeline_step_copy", default=None
)

# Cancel callback for render_lock waits in this context (a pipeline run's cancel_check).
_render_cancel_check: ContextVar[Callable[[], bool] | None] = ContextVar(
    "render_cancel_check", default=None
)


class RenderBusyError(Timeout):
    """Another render of this workspace held ``render_lock`` past the caller's timeout (#482).

    A ``filelock.Timeout``, so adapters that map the project-lock timeout to a busy error
    (``project_busy``: the GUI audio and document routes) map this one the same way; CLI
    and MCP adapters do not yet (#488).
    """

    def __str__(self) -> str:
        return "another render of this project is in progress; try again when it finishes"


def _workspace_key(project: EpisodeProject) -> str:
    return str(project.workspace_path().resolve())


def project_commit_lock_path(project: EpisodeProject) -> Path:
    """Lock file for cross-process commits (not under ``history/``: that dir arms index writes)."""
    return workspace_artifacts_dir(project.workspace_path().resolve()) / "episode.project.json.lock"


def render_lock_path(project: EpisodeProject) -> Path:
    """Lock file serializing writers of stems, ``premix.wav`` and ``mastered.wav`` (#482)."""
    return workspace_artifacts_dir(project.workspace_path().resolve()) / "render.lock"


def project_state_lock(project: EpisodeProject) -> RLock:
    """Return the in-process lock shared by this workspace's mutations and reads."""
    return _locks.get(_workspace_key(project))


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
def step_copy(live: EpisodeProject, work: EpisodeProject) -> Iterator[None]:
    """Mark ``work`` as a pipeline step's private copy of ``live`` for this context (#357)."""
    token = _step_copy.set((work, live))
    try:
        yield
    finally:
        _step_copy.reset(token)


def live_project(project: EpisodeProject) -> EpisodeProject:
    """The live project ``project`` was copied from for a pipeline step, else ``project``.

    Guards that must notice concurrent in-memory edits (the stem render's "project changed
    during rendering" check) compare against this, not against the step's private copy,
    which nothing else mutates.
    """
    pair = _step_copy.get()
    if pair is not None and pair[0] is project:
        return pair[1]
    return project


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
def render_cancel_scope(cancel_check: Callable[[], bool] | None) -> Iterator[None]:
    """Let ``render_lock`` waits in this context stop once ``cancel_check()`` is true."""
    token = _render_cancel_check.set(cancel_check)
    try:
        yield
    finally:
        _render_cancel_check.reset(token)


def render_lock_held(project: EpisodeProject) -> bool:
    """Whether this thread holds ``render_lock(project)`` (the file lock is thread-local)."""
    return shared_file_lock(render_lock_path(project), timeout=RENDER_LOCK_TIMEOUT_SEC).is_locked


def _commit_lock_held(project: EpisodeProject) -> bool:
    return shared_file_lock(
        project_commit_lock_path(project), timeout=PROJECT_COMMIT_LOCK_TIMEOUT_SEC
    ).is_locked


@contextmanager
def render_lock(
    project: EpisodeProject,
    *,
    timeout: float = RENDER_LOCK_TIMEOUT_SEC,
    cancel_check: Callable[[], bool] | None = None,
) -> Iterator[None]:
    """Serialize render writers of this workspace across threads and processes (#356, #482).

    Held around every write of ``artifacts/tracks/<id>.wav`` + ``.hash``, ``premix.wav`` +
    ``premix.hash`` and ``mastered.wav`` + ``mastered.hash`` (stem render, mix, master,
    export, bleed-mute rewrite, on-demand ``ensure_stem``). Re-entrant per thread. Stem
    worker threads of the holder never take it: the file lock is thread-local, so a worker
    would wait on its own parent. Readers never take it. Hash deletions that only make a
    stem stale (``invalidate_stem_hashes`` inside an undo/redo transaction) run without it:
    a publish racing one writes a hash naming its own snapshot, which freshness rejects
    if the project moved.

    Lock order: take it before ``project_state_lock`` / ``project_commit_lock``, never while
    holding them (unless this thread already holds it). A first acquire while this thread
    holds the commit lock raises ``RuntimeError`` instead of risking a deadlock.

    Use ``@with_render_lock`` on functions whose first argument is the project (pipeline
    steps, ``rerender_preview``), and ``with render_lock(project):`` in services, which
    hold ``self.ws.project``.

    Waits in ``RENDER_LOCK_POLL_SEC`` slices for up to ``timeout``. Between slices,
    ``cancel_check`` (or the one set by ``render_cancel_scope``) returning true raises
    ``CancelledProgress``. After ``timeout`` it raises ``RenderBusyError``.
    """
    lock = shared_file_lock(render_lock_path(project), timeout=RENDER_LOCK_TIMEOUT_SEC)
    if not lock.is_locked and _commit_lock_held(project):
        raise RuntimeError(
            "render_lock taken while holding project_commit_lock; lock order is the render "
            "lock, then the project locks (#482)"
        )
    check = cancel_check if cancel_check is not None else _render_cancel_check.get()
    deadline = time.monotonic() + timeout
    try:
        lock.acquire(timeout=0)
    except Timeout:
        log.info("waiting for another render of %s", project.workspace_path())
        while True:
            if check is not None and check():
                raise CancelledProgress("cancelled while waiting for another render") from None
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RenderBusyError(str(render_lock_path(project))) from None
            try:
                lock.acquire(timeout=min(RENDER_LOCK_POLL_SEC, remaining))
                break
            except Timeout:
                continue
    try:
        yield
    finally:
        lock.release()


def with_render_lock(
    fn: Callable[Concatenate[EpisodeProject, _P], _R],
) -> Callable[Concatenate[EpisodeProject, _P], _R]:
    """Decorator: hold ``render_lock`` of the first argument (the project) around ``fn``.

    For project-first functions (pipeline steps, ``rerender_preview``); services use
    ``with render_lock(self.ws.project):``.
    """

    @functools.wraps(fn)
    def wrapper(project: EpisodeProject, /, *args: _P.args, **kwargs: _P.kwargs) -> _R:
        with render_lock(project):
            return fn(project, *args, **kwargs)

    return wrapper
