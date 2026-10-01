"""Checkpoint history before a record/commit and roll it back if that step fails."""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any

from podcast_mcp.models import EpisodeProject, load_project, project_file_path
from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.project_store import (
    ProjectStore,
    commit_landed,
    history_index_adoptable,
    history_index_path,
    history_index_to_restore,
    history_snapshot_ids,
    read_history_index,
    restore_history_index,
    rollback_history,
    rollback_own_history,
)
from podcast_mcp.util.project_state import (
    FileRevision,
    project_commit_lock,
    project_file_revision,
)

log = logging.getLogger(__name__)


class RollbackOutcome(StrEnum):
    """What ``roll_back_history`` found and did to history after a failed record/commit step.

    Only ``project.history`` is handled here; the caller decides what other in-memory state
    to keep (``rolled_back_on_failure``'s ``on_not_landed``).
    """

    LANDED = "landed"  # the commit replaced the project file: its history is kept
    UNKNOWN = "unknown"  # landing unverified: index and snapshots stay on disk
    RESTORED = "restored"  # index, snapshots and project.history are back at the checkpoint
    KEPT = "kept"


class HistoryRollbackPolicy(StrEnum):
    """Whether rollback must preserve a concurrent writer or owns the locked call's writes."""

    OWNED_WRITES = "owned_writes"
    LOCKED_CALL = "locked_call"


@dataclass
class HistoryCheckpoint:
    """History state before recording, for ``roll_back_history`` after a failure."""

    index_path: Path
    index_before: dict[str, Any] | None
    history_before: ProjectHistory
    policy: HistoryRollbackPolicy = HistoryRollbackPolicy.OWNED_WRITES
    snapshots_before: set[str] = field(default_factory=set)
    own_indexes: list[dict[str, Any] | None] = field(default_factory=list)
    commit_started: bool = False
    revision_before_commit: FileRevision | None = None

    def start_commit(self, project: EpisodeProject) -> None:
        """Remember the project file revision just before ``store.commit``.

        Call under ``project_commit_lock``, after ``record``: a failure before this point
        is never mistaken for a commit that landed.
        """
        self.revision_before_commit = project_file_revision(project)
        self.commit_started = True


def take_history_checkpoint(
    store: ProjectStore,
    project: EpisodeProject,
    *,
    policy: HistoryRollbackPolicy = HistoryRollbackPolicy.OWNED_WRITES,
    index_fallback: ProjectHistory | None = None,
) -> HistoryCheckpoint:
    """Capture history and disk rollback baselines; call under ``project_commit_lock``.

    ``OWNED_WRITES`` adopts the index and uses payload ownership checks because another
    writer may commit between history phases. ``LOCKED_CALL`` preserves the caller's
    in-memory history and captures all snapshot files for unconditional rollback while an
    outer commit lock excludes other writers.
    """
    unreadable_index = False
    if policy is HistoryRollbackPolicy.OWNED_WRITES:
        try:
            store.adopt_history_index(project)
        except ValueError:
            unreadable_index = True
            log.warning(
                "Unreadable %s; using the project's history as rollback baseline",
                history_index_path(project),
            )
    history_before = project.history.model_copy(deep=True)
    index_path = history_index_path(project)
    if unreadable_index:
        restore_history_index(index_path, history_before.model_dump(mode="json"))
    return HistoryCheckpoint(
        index_path=index_path,
        index_before=history_index_to_restore(
            index_path, index_fallback if index_fallback is not None else history_before
        ),
        history_before=history_before,
        policy=policy,
        snapshots_before=(
            history_snapshot_ids(index_path)
            if policy is HistoryRollbackPolicy.LOCKED_CALL
            else set()
        ),
    )


def roll_back_history(project: EpisodeProject, checkpoint: HistoryCheckpoint) -> RollbackOutcome:
    """Undo the history recorded since ``checkpoint`` after a failure (best effort).

    One ``project_commit_lock`` hold covers the "did the commit land" check and the
    rollback. Kept when the commit landed; only ``project.history`` is restored when the
    project file cannot be stat'ed. For ``OWNED_WRITES``, another writer's entry is adopted
    so the next commit does not overwrite it. For ``LOCKED_CALL``, rollback preserves the
    caller's in-memory baseline because its index may contain a partial merged write.
    Without the lock a changed file revision may be another writer's commit, so that path
    reports ``UNKNOWN``, never ``LANDED``. The caller re-raises the original error; failures
    here are only logged.
    """
    try:
        with project_commit_lock(project):
            return _roll_back_locked(project, checkpoint)
    except Exception:
        log.warning(
            "Could not roll back %s after a failed mutation", checkpoint.index_path, exc_info=True
        )
        if checkpoint.policy is HistoryRollbackPolicy.LOCKED_CALL:
            project.history = checkpoint.history_before
        else:
            project.history = _history_on_disk(project, checkpoint)
        # Without the lock a changed revision may be another writer's commit, not this one.
        landed = _commit_landed(project, checkpoint)
        return RollbackOutcome.KEPT if landed is False else RollbackOutcome.UNKNOWN


@contextmanager
def rolled_back_on_failure(
    project: EpisodeProject,
    checkpoint: HistoryCheckpoint,
    *,
    on_not_landed: Callable[[], None] | None = None,
    on_failure: Callable[[RollbackOutcome], None] | None = None,
) -> Iterator[None]:
    """Run the block; on any failure (``BaseException``) roll back history since ``checkpoint``.

    Wraps only the rollback; callers keep their own ``project_commit_lock`` scope. Unless the
    commit landed, ``on_not_landed`` then runs (``run_mutation`` restores memory there), also
    when the rollback itself raises. ``on_failure`` receives the final outcome after memory
    recovery. The original error is re-raised; rollback and hook errors are only logged.
    """
    try:
        yield
    except BaseException:
        _compensate(project, checkpoint, on_not_landed, on_failure)
        raise


def _compensate(
    project: EpisodeProject,
    checkpoint: HistoryCheckpoint,
    on_not_landed: Callable[[], None] | None,
    on_failure: Callable[[RollbackOutcome], None] | None,
) -> None:
    outcome = RollbackOutcome.UNKNOWN
    try:
        outcome = roll_back_history(project, checkpoint)
    except Exception:
        log.warning("Could not finish rolling back %s", checkpoint.index_path, exc_info=True)
    finally:
        if on_not_landed is not None and outcome is not RollbackOutcome.LANDED:
            try:
                on_not_landed()
            except Exception:
                log.warning(
                    "Could not restore the in-memory project after a failed mutation",
                    exc_info=True,
                )
        if on_failure is not None:
            try:
                on_failure(outcome)
            except Exception:
                log.warning("Could not handle failed mutation outcome", exc_info=True)


def _commit_landed(project: EpisodeProject, checkpoint: HistoryCheckpoint) -> bool | None:
    """Whether the checkpoint's commit replaced the project file (``None``: unknown)."""
    if not checkpoint.commit_started:
        return False
    return commit_landed(project, checkpoint.revision_before_commit)


def _roll_back_locked(project: EpisodeProject, checkpoint: HistoryCheckpoint) -> RollbackOutcome:
    landed = _commit_landed(project, checkpoint)
    if landed:
        return RollbackOutcome.LANDED
    if landed is None:
        project.history = checkpoint.history_before
        log.warning(
            "Leaving %s and its snapshots in place after a failed mutation", checkpoint.index_path
        )
        return RollbackOutcome.UNKNOWN
    if checkpoint.policy is HistoryRollbackPolicy.LOCKED_CALL:
        new_snapshot_ids = history_snapshot_ids(checkpoint.index_path) - checkpoint.snapshots_before
        rollback_history(checkpoint.index_path, checkpoint.index_before, new_snapshot_ids)
        project.history = checkpoint.history_before
        return RollbackOutcome.RESTORED
    before_ids = {entry.id for entry in checkpoint.history_before.entries}
    own_ids = [entry.id for entry in project.history.entries if entry.id not in before_ids]
    own_indexes = [*checkpoint.own_indexes, project.history.model_dump(mode="json")]
    if rollback_own_history(checkpoint.index_path, checkpoint.index_before, own_indexes, own_ids):
        project.history = checkpoint.history_before
        return RollbackOutcome.RESTORED
    log.warning("%s changed during a failed mutation; keeping its entries", checkpoint.index_path)
    project.history = _history_on_disk(project, checkpoint)
    return RollbackOutcome.KEPT


def _history_on_disk(project: EpisodeProject, checkpoint: HistoryCheckpoint) -> ProjectHistory:
    """``history/index.json`` as read now; ``history_before`` when absent or unreadable.

    From an empty ``history_before`` the index is kept only when its current entry matches
    the saved project, the rule ``ProjectStore.adopt_history_index`` applies on load, so an
    index a dead commit left ahead of the saved project (#576) never lands in memory.
    """
    try:
        history = read_history_index(checkpoint.index_path)
    except ValueError:  # includes pydantic.ValidationError
        log.warning(
            "Unreadable %s; keeping the history from before the failure",
            checkpoint.index_path,
            exc_info=True,
        )
        return checkpoint.history_before
    if history is None:
        return checkpoint.history_before
    if checkpoint.history_before.is_empty() and not history.is_empty():
        try:
            saved = load_project(project_file_path(project.workspace_path()))
        except (OSError, ValueError):  # ValueError includes pydantic.ValidationError
            log.warning(
                "Could not read the saved project to check %s", checkpoint.index_path, exc_info=True
            )
            return checkpoint.history_before
        if not history_index_adoptable(saved, history, checkpoint.index_path):
            return checkpoint.history_before
    return history
