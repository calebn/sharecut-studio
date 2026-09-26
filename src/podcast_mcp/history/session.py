from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TypeVar

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
from podcast_mcp.history.rollback import (
    RollbackOutcome,
    roll_back_history,
    rolled_back_on_failure,
    take_history_checkpoint,
)
from podcast_mcp.models import EpisodeProject, ProjectStateSnapshot, RenderSection
from podcast_mcp.project_store import (
    ProjectStore,
)
from podcast_mcp.util.project_state import (
    project_commit_lock,
    project_state_lock,
)
from podcast_mcp.util.tracks import dialogue_track_ids

T = TypeVar("T")
log = logging.getLogger(__name__)


@dataclass(frozen=True)
class _PreMutateState:
    """In-memory state run_mutation puts back when its call did not land on disk (#489).

    Editable snapshot plus ``render`` (written by the audio bookkeeping); history is
    restored separately by roll_back_history.
    """

    editable: ProjectStateSnapshot
    render: RenderSection

    @classmethod
    def capture(cls, project: EpisodeProject) -> _PreMutateState:
        return cls(snapshot_from_project(project), project.render.model_copy(deep=True))

    def restore(self, project: EpisodeProject) -> None:
        apply_snapshot_to_project(project, self.editable)
        project.render = self.render


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
    with project_commit_lock(project):
        checkpoint = take_history_checkpoint(store, project)
        with rolled_back_on_failure(project, checkpoint):
            mgr.record(project, label_before)
    checkpoint.own_indexes.append(project.history.model_dump(mode="json"))
    pre_mutate = _PreMutateState.capture(project)
    try:
        result = mutate(project)
        _record_audio_changes(
            project,
            fingerprint_before=fingerprint_before,
            track_hashes_before=track_hashes_before,
            log_len_before=log_len_before,
            operation=operation,
        )
        # record() and commit() each take the re-entrant lock; this outer hold makes
        # record(after) + commit one cross-process step so no other commit lands between them.
        with project_commit_lock(project):
            mgr.record(project, label_after, operation=operation, params=params)
            checkpoint.start_commit(project)
            store.commit(project)
    except BaseException:
        # Memory follows the file: keep the mutated state only if the commit replaced it.
        if roll_back_history(project, checkpoint) is not RollbackOutcome.LANDED:
            pre_mutate.restore(project)
        raise
    return result


def _record_audio_changes(
    project: EpisodeProject,
    *,
    fingerprint_before: str,
    track_hashes_before: dict[str, str],
    log_len_before: int,
    operation: str | None,
) -> None:
    if audio_state_fingerprint(project) == fingerprint_before:
        return
    mark_reconciliation_stale(project)
    changed_tracks = [
        tid
        for tid in dialogue_track_ids(project)
        if track_render_hash(project, tid) != track_hashes_before.get(tid)
    ]
    record_after_audio_mutation(
        project,
        changed_track_ids=changed_tracks,
        operation=operation,
        new_edit_log=project.editorial.edit_log[log_len_before:],
    )
    fresh_changed = [tid for tid in changed_tracks if stem_is_fresh(project, tid)]
    if fresh_changed:
        maybe_auto_reconcile(project, track_ids=fresh_changed)
