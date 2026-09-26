from __future__ import annotations

import logging
from collections.abc import Callable
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
from podcast_mcp.history.rollback import roll_back_history, take_history_checkpoint
from podcast_mcp.models import EpisodeProject
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
        try:
            mgr.record(project, label_before)
        except BaseException:
            roll_back_history(project, checkpoint)
            raise
    checkpoint.own_indexes.append(project.history.model_dump(mode="json"))
    pre_mutate = snapshot_from_project(project)
    try:
        try:
            result = mutate(project)
        except BaseException:
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
            checkpoint.start_commit(project)
            mgr.record(project, label_after, operation=operation, params=params)
            store.commit(project)
    except BaseException:
        roll_back_history(project, checkpoint)
        raise
    return result
