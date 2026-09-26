"""Checkpoint history before a record/commit and roll it back if that step fails."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from podcast_mcp.models import EpisodeProject
from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.project_store import (
    ProjectStore,
    commit_landed,
    history_index_path,
    history_index_to_restore,
    rollback_own_history,
)
from podcast_mcp.util.atomic_json import load_json_object
from podcast_mcp.util.project_state import (
    FileRevision,
    project_commit_lock,
    project_file_revision,
)

log = logging.getLogger(__name__)


@dataclass
class HistoryCheckpoint:
    """History state before recording, for ``roll_back_history`` after a failure."""

    index_path: Path
    index_before: dict[str, Any] | None
    history_before: ProjectHistory
    own_indexes: list[dict[str, Any] | None] = field(default_factory=list)
    commit_started: bool = False
    revision_before_commit: FileRevision | None = None

    def start_commit(self, project: EpisodeProject) -> None:
        """Remember the project file revision; call under ``project_commit_lock``."""
        self.revision_before_commit = project_file_revision(project)
        self.commit_started = True


def take_history_checkpoint(store: ProjectStore, project: EpisodeProject) -> HistoryCheckpoint:
    """``project``'s history before recording; call under ``project_commit_lock``."""
    store.adopt_history_index(project)  # history_before must include adopted entries
    history_before = project.history.model_copy(deep=True)
    index_path = history_index_path(project)
    return HistoryCheckpoint(
        index_path=index_path,
        index_before=history_index_to_restore(index_path, history_before),
        history_before=history_before,
    )


def roll_back_history(project: EpisodeProject, checkpoint: HistoryCheckpoint) -> None:
    """Undo the history recorded since ``checkpoint`` after a failure (best effort).

    One ``project_commit_lock`` hold covers the "did the commit land" check and the
    rollback. Kept when the commit landed; only memory is restored when the project file
    cannot be stat'ed. When another writer recorded on top, or the rollback itself fails,
    the index on disk is kept and ``project.history`` adopts it, so the next commit does not
    overwrite it. The caller re-raises the original error; failures here are only logged.
    """
    try:
        with project_commit_lock(project):
            _roll_back_locked(project, checkpoint)
    except Exception:
        log.warning(
            "Could not roll back %s after a failed mutation", checkpoint.index_path, exc_info=True
        )
        project.history = _history_on_disk(checkpoint)


def _roll_back_locked(project: EpisodeProject, checkpoint: HistoryCheckpoint) -> None:
    landed = (
        commit_landed(project, checkpoint.revision_before_commit)
        if checkpoint.commit_started
        else False
    )
    if landed:
        return
    if landed is None:
        project.history = checkpoint.history_before
        log.warning(
            "Leaving %s and its snapshots in place after a failed mutation", checkpoint.index_path
        )
        return
    before_ids = {entry.id for entry in checkpoint.history_before.entries}
    own_ids = [entry.id for entry in project.history.entries if entry.id not in before_ids]
    own_indexes = [*checkpoint.own_indexes, project.history.model_dump(mode="json")]
    if rollback_own_history(checkpoint.index_path, checkpoint.index_before, own_indexes, own_ids):
        project.history = checkpoint.history_before
        return
    log.warning("%s changed during a failed mutation; keeping its entries", checkpoint.index_path)
    project.history = _history_on_disk(checkpoint)


def _history_on_disk(checkpoint: HistoryCheckpoint) -> ProjectHistory:
    """``history/index.json`` as read now; ``history_before`` when absent or unreadable."""
    try:
        data = load_json_object(checkpoint.index_path)
        if data is not None:
            return ProjectHistory.model_validate(data)
    except ValueError:  # includes pydantic.ValidationError
        log.warning(
            "Unreadable %s; keeping the history from before the failure",
            checkpoint.index_path,
            exc_info=True,
        )
    return checkpoint.history_before
