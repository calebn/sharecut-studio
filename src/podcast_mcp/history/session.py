from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeVar

from podcast_mcp.edits.transcript_reconcile import maybe_auto_reconcile
from podcast_mcp.engines.play_audit import stem_is_fresh, track_render_hash
from podcast_mcp.engines.reconciliation_state import (
    audio_state_fingerprint,
    mark_reconciliation_stale,
)
from podcast_mcp.engines.render_invalidations import record_after_audio_mutation
from podcast_mcp.history.manager import (
    HistoryManager,
    apply_snapshot_to_project,
    snapshot_from_project,
)
from podcast_mcp.models import EpisodeProject
from podcast_mcp.models.history import ProjectHistory
from podcast_mcp.project_store import (
    ProjectStore,
    history_index_path,
    history_index_to_restore,
    rollback_own_history,
)
from podcast_mcp.util.project_state import (
    FileRevision,
    project_commit_lock,
    project_file_revision,
    project_state_lock,
)
from podcast_mcp.util.tracks import dialogue_track_ids

T = TypeVar("T")
log = logging.getLogger(__name__)


@dataclass
class _HistoryCheckpoint:
    """History state before a mutation, for compensating a failure."""

    index_path: Path
    index_before: dict[str, Any] | None
    history_before: ProjectHistory
    own_indexes: list[dict[str, Any] | None] = field(default_factory=list)
    commit_started: bool = False
    revision_before_commit: FileRevision | None = None


def run_mutation(
    path: Path,
    project: EpisodeProject,
    label_before: str,
    label_after: str,
    mutate: Callable[[EpisodeProject], T],
    *,
    operation: str | None = None,
    params: dict | None = None,
) -> T:
    with project_state_lock(project):
        return _run_mutation_locked(
            path,
            project,
            label_before,
            label_after,
            mutate,
            operation=operation,
            params=params,
        )


def _run_mutation_locked(
    path: Path,
    project: EpisodeProject,
    label_before: str,
    label_after: str,
    mutate: Callable[[EpisodeProject], T],
    *,
    operation: str | None,
    params: dict | None,
) -> T:
    store = ProjectStore(path)
    mgr = HistoryManager(path)
    fingerprint_before = audio_state_fingerprint(project)
    track_hashes_before = {
        tid: track_render_hash(project, tid) for tid in dialogue_track_ids(project)
    }
    log_len_before = len(project.editorial.edit_log)
    index_path = history_index_path(project)
    with project_commit_lock(project):
        store.adopt_history_index(project)  # history_before must include adopted entries
        history_before = project.history.model_copy(deep=True)
        checkpoint = _HistoryCheckpoint(
            index_path=index_path,
            index_before=history_index_to_restore(index_path, history_before),
            history_before=history_before,
        )
        mgr.record(project, label_before)
    checkpoint.own_indexes.append(project.history.model_dump(mode="json"))
    pre_mutate = snapshot_from_project(project)
    try:
        try:
            result = mutate(project)
        except Exception:
            apply_snapshot_to_project(project, pre_mutate)
            raise
        fingerprint_after = audio_state_fingerprint(project)
        if fingerprint_before != fingerprint_after:
            mark_reconciliation_stale(project)
            changed_tracks = [
                tid
                for tid in dialogue_track_ids(project)
                if track_render_hash(project, tid) != track_hashes_before.get(tid)
            ]
            new_log = project.editorial.edit_log[log_len_before:]
            record_after_audio_mutation(
                project,
                changed_track_ids=changed_tracks,
                operation=operation,
                new_edit_log=new_log,
            )
            fresh_changed = [tid for tid in changed_tracks if stem_is_fresh(project, tid)]
            if fresh_changed:
                maybe_auto_reconcile(project, track_ids=fresh_changed)
        # record() and commit() each take the re-entrant lock; this outer hold makes
        # record(after) + commit one cross-process step so no other commit lands between them.
        with project_commit_lock(project):
            checkpoint.revision_before_commit = project_file_revision(project)
            checkpoint.commit_started = True
            mgr.record(project, label_after, operation=operation, params=params)
            store.commit(project)
    except Exception:
        _roll_back_history(project, checkpoint)
        raise
    return result


def _roll_back_history(project: EpisodeProject, checkpoint: _HistoryCheckpoint) -> None:
    """Undo this call's history entries after a failed mutation (best effort).

    Kept when the commit landed, or when another writer recorded on top. The original
    error is re-raised by the caller; failures here are only logged.
    """
    landed: bool | None = False
    if checkpoint.commit_started:
        try:
            landed = project_file_revision(project) != checkpoint.revision_before_commit
        except OSError:
            landed = None
            log.warning("Could not stat the project file after a failed mutation", exc_info=True)
    if landed:
        return
    before_ids = {entry.id for entry in checkpoint.history_before.entries}
    own_ids = [entry.id for entry in project.history.entries if entry.id not in before_ids]
    own_indexes = [*checkpoint.own_indexes, project.history.model_dump(mode="json")]
    project.history = checkpoint.history_before
    if landed is None:
        log.warning(
            "Leaving %s and its snapshots in place after a failed mutation", checkpoint.index_path
        )
        return
    try:
        with project_commit_lock(project):
            if not rollback_own_history(
                checkpoint.index_path, checkpoint.index_before, own_indexes, own_ids
            ):
                log.warning(
                    "%s changed during a failed mutation; keeping its entries",
                    checkpoint.index_path,
                )
    except Exception:
        log.warning(
            "Could not roll back %s after a failed mutation", checkpoint.index_path, exc_info=True
        )
