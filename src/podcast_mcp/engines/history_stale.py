"""Stale marks for an undo, redo or history jump: only what the move changed (#424)."""

from __future__ import annotations

from dataclasses import dataclass

from podcast_mcp.engines.play_audit import (
    changed_render_hashes,
    dialogue_render_hashes,
    stem_hash_matches,
)
from podcast_mcp.engines.reconciliation_state import (
    audio_state_fingerprint,
    mark_reconciliation_stale,
)
from podcast_mcp.engines.render_invalidations import (
    clear_invalidations_for_tracks,
    replace_with_whole_track,
)
from podcast_mcp.models import EpisodeProject


@dataclass(frozen=True)
class AudioStateBefore:
    """Dialogue audio identity captured before a history move."""

    fingerprint: str
    render_hashes: dict[str, str]

    @classmethod
    def capture(cls, project: EpisodeProject) -> AudioStateBefore:
        hashes = dialogue_render_hashes(project)
        return cls(audio_state_fingerprint(project, hashes), hashes)


def mark_history_move_stale(project: EpisodeProject, before: AudioStateBefore) -> None:
    """Mark stale what the move changed, and nothing else.

    Stem hash sidecars stay: ``track_render_hash`` is content-addressed and every reader
    compares against it, so a stem is stale exactly when its sidecar no longer matches,
    and fresh again when a redo returns to the state it was rendered at. Reconciliation
    is marked stale only when ``audio_state_fingerprint`` moved. The render cause journal
    changes only for dialogue tracks whose render hash changed: one whose stem WAV exists
    and whose sidecar matches the restored state drops its cause journal, and any other
    changed track gets a whole-track marker. A track the move removed loses its
    cause-journal rows.

    Runs inside the undo/redo transaction without ``render_lock`` (taking it there would
    invert the lock order) and reads stem hash sidecars. That is safe only because
    ``publish_stem`` drops the old hash, swaps the WAV in, and only then writes the new
    hash, so a sidecar only ever names the bytes beside it. Keep that order.
    """
    after = dialogue_render_hashes(project)
    if audio_state_fingerprint(project, after) != before.fingerprint:
        mark_reconciliation_stale(project)
    changed = changed_render_hashes(before.render_hashes, after)
    rendered = [tid for tid in changed if stem_hash_matches(project, tid, after[tid])]
    removed = [tid for tid in before.render_hashes if tid not in after]
    clear_invalidations_for_tracks(project, [*rendered, *removed])
    replace_with_whole_track(
        project, [tid for tid in changed if tid not in rendered], reason="other"
    )
