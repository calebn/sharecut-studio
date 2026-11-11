"""Move the open episode's folder to another folder on the same drive.

The rename of the whole folder is the commit point: history, artifacts, media and the sidecars
travel with it and the project file keeps no absolute path. Everything outside the folder that
names it (the share registry, the share sidecar, the recent list, the served project) is
repointed afterwards; if that fails the folder is renamed back.
"""

from __future__ import annotations

import contextlib
import errno
import logging
import os
import time
from collections.abc import Callable
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from filelock import Timeout

from podcast_mcp.models.episode import EPISODE_PROJECT_FILENAME
from podcast_mcp.project.io import ensure_utf8_path
from podcast_mcp.services.app.recent_projects import forget_recent, record_recent
from podcast_mcp.services.app.workspace import ProjectWorkspace
from podcast_mcp.services.app.workspace_release import release_workspace
from podcast_mcp.services.collaboration import get_share_registry, rebase_sidecar_workspace
from podcast_mcp.services.jobs import LIVE_JOB_STATUSES
from podcast_mcp.services.record import RecordSessionService
from podcast_mcp.services.session_sync import cached_sync_store_if_exists, sync_db_path
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.progress import CancelledProgress
from podcast_mcp.util.project_state import (
    project_commit_lock,
    render_cancel_scope,
    render_lock,
)

log = logging.getLogger(__name__)

LOCK_WAIT_SEC = 2.0
"""How long a move waits for the project's locks before it answers ``project_busy``."""

PRESENCE_MAX_AGE_NS = 30_000_000_000
"""A window counts as connected when its presence row was refreshed within this long."""


class MoveRefused(CodedError):
    """A move that was refused, or that failed and left the episode where it was."""


class MovePartial(MoveRefused):
    """The folder moved but could not be put back after a later step failed."""

    code = "project_moved_partial"

    def __init__(self, message: str, *, project_path: Path) -> None:
        super().__init__(message)
        self.project_path = project_path


@dataclass(frozen=True)
class MoveResult:
    project_path: Path
    previous_path: Path


def _device_of(path: Path) -> int:
    return os.stat(path).st_dev


def _invalid(message: str) -> MoveRefused:
    return MoveRefused(message, code="move_dest_invalid")


def _checked_dest_parent(raw: str, source: Path) -> Path:
    if not raw or not Path(raw).is_absolute():
        raise _invalid("Choose the folder by its full path.")
    try:
        ensure_utf8_path(raw)
        root = Path(raw).resolve(strict=True)
    except (OSError, ValueError):
        raise _invalid("That folder isn't available. Choose an existing folder.") from None
    if not root.is_dir():
        raise _invalid("That isn't a folder. Choose an existing folder.")
    if root == source or source in root.parents:
        raise _invalid("A folder can't be moved into itself. Choose another folder.")
    if not os.access(root, os.W_OK | os.X_OK):
        raise _invalid("This computer can't write to that folder. Choose another folder.")
    return root


def _refuse_if_busy(
    project_file: Path, ws: ProjectWorkspace, *, jobs: Any, caller_client_id: str | None
) -> None:
    if jobs is not None and any(
        job["status"] in LIVE_JOB_STATUSES for job in jobs.status(str(project_file))["jobs"]
    ):
        raise MoveRefused("A run or export is working on this episode.", code="move_busy_jobs")
    if RecordSessionService.active_session_id(ws.project):
        raise MoveRefused("A recording room is open for this episode.", code="move_room_open")
    store = cached_sync_store_if_exists(sync_db_path(ws.project))
    if store is not None and any(
        row["client_id"] != caller_client_id
        for row in store.list_clients(max_age_ns=PRESENCE_MAX_AGE_NS)
    ):
        raise MoveRefused(
            "Someone else has this episode open in another window.", code="move_others_connected"
        )


def _reserve(parent: Path, name: str) -> Path:
    """Create ``parent/name``, numbered " 2", " 3"... when taken, so two moves never share one."""
    n = 1
    while True:
        candidate = parent / (name if n == 1 else f"{name} {n}")
        try:
            os.mkdir(candidate)
        except FileExistsError:
            n += 1
            continue
        return candidate


def _rename(source: Path, target: Path) -> None:
    """Rename ``source`` onto the empty reserved ``target``; a refusal leaves both as they were."""
    try:
        if os.name == "nt":
            # Windows will not rename onto an existing folder; a squatter that appears in the
            # gap makes the rename fail instead.
            os.rmdir(target)
        os.rename(source, target)
    except PermissionError as exc:
        raise MoveRefused(
            "Another program is using this episode's files.", code="move_in_use"
        ) from exc
    except OSError as exc:
        if isinstance(exc, FileExistsError) or exc.errno in (errno.ENOTEMPTY, errno.EEXIST):
            raise MoveRefused(
                "That folder already has this episode's name.", code="move_dest_exists"
            ) from exc
        if exc.errno == errno.EXDEV:
            raise MoveRefused(
                "That folder is on a different drive.", code="move_cross_volume"
            ) from exc
        log.warning("Cannot rename %s to %s", source, target, exc_info=exc)
        raise MoveRefused(
            "The move didn't finish, so the episode stays where it was.", code="move_failed"
        ) from exc


def move_episode_folder(
    project_file: Path,
    dest_parent: str,
    *,
    jobs: Any,
    caller_client_id: str | None,
    serve: Callable[[Path], None],
) -> MoveResult:
    """Move the folder holding ``project_file`` into ``dest_parent`` and repoint what names it.

    ``serve`` retargets the served project to a project file path; it runs after the rename
    and again, with the old path, if the move is rolled back.
    """
    source_file = project_file.resolve()
    source = source_file.parent
    dest_root = _checked_dest_parent(dest_parent, source)
    if dest_root == source.parent:
        raise MoveRefused("This episode is already in that folder.", code="move_dest_exists")
    if _device_of(source) != _device_of(dest_root):
        raise MoveRefused("That folder is on a different drive.", code="move_cross_volume")
    ws = ProjectWorkspace.open(source_file)
    _refuse_if_busy(source_file, ws, jobs=jobs, caller_client_id=caller_client_id)

    with ExitStack() as held:
        deadline = time.monotonic() + LOCK_WAIT_SEC
        try:
            with render_cancel_scope(lambda: time.monotonic() > deadline):
                held.enter_context(render_lock(ws.project, timeout=LOCK_WAIT_SEC))
                held.enter_context(project_commit_lock(ws.project, timeout=LOCK_WAIT_SEC))
        except (Timeout, CancelledProgress):
            raise MoveRefused("This project is busy; try again.", code="project_busy") from None
        return _move_locked(source_file, dest_root, serve=serve)


def _move_locked(
    source_file: Path, dest_root: Path, *, serve: Callable[[Path], None]
) -> MoveResult:
    source = source_file.parent
    target = _reserve(dest_root, source.name)
    try:
        _rename(source, target)
    except BaseException:
        # A reservation another process already filled is not removed (rmdir needs it empty).
        with contextlib.suppress(OSError):
            os.rmdir(target)
        raise
    target_file = target / EPISODE_PROJECT_FILENAME
    release_workspace(source)
    try:
        _repoint(source, target, target_file, serve)
    except Exception as exc:
        _undo(source, target, source_file, target_file, serve, exc)
    forget_recent(source_file)
    record_recent(target_file)
    return MoveResult(project_path=target_file, previous_path=source_file)


def _repoint(old: Path, new: Path, new_file: Path, serve: Callable[[Path], None]) -> None:
    get_share_registry().rebase_workspace(str(old), str(new))
    rebase_sidecar_workspace(new, str(old), str(new))
    serve(new_file)


def _undo(
    source: Path,
    target: Path,
    source_file: Path,
    target_file: Path,
    serve: Callable[[Path], None],
    cause: Exception,
) -> None:
    """Put the folder back after a failed repoint, or finish the move where the folder is."""
    log.warning("Move of %s failed after the rename", source, exc_info=cause)
    try:
        os.rename(target, source)
    except OSError:
        log.warning("Cannot rename %s back to %s", target, source, exc_info=True)
        # The folder stays at its new path: repoint what can be, so the move is at least whole.
        for step in (
            lambda: get_share_registry().rebase_workspace(str(source), str(target)),
            lambda: rebase_sidecar_workspace(target, str(source), str(target)),
            lambda: serve(target_file),
        ):
            with contextlib.suppress(Exception):
                step()
        forget_recent(source_file)
        record_recent(target_file)
        raise MovePartial(
            "The episode moved, but some links could not be updated.", project_path=target_file
        ) from cause
    for step in (
        lambda: get_share_registry().rebase_workspace(str(target), str(source)),
        lambda: rebase_sidecar_workspace(source, str(target), str(source)),
        lambda: serve(source_file),
    ):
        with contextlib.suppress(Exception):
            step()
    raise MoveRefused(
        "The move didn't finish, so the episode stays where it was.", code="move_failed"
    ) from cause
