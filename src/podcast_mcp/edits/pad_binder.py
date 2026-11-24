"""Bind each pending padded cut's room-tone pick as the cuts are proposed (#3600).

The pass lays the pending padded cuts one after another on a private copy, later source
first as an approve does, so the pick of each sees the pads the cuts after it already play
and no two nearby pads share a sample. What it picked is kept on the cut
(``EditDecision.bound_pad``); preview and approve then play it whatever else was applied or
approved before. It writes nothing but those bindings.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits import pad_binding
from podcast_mcp.edits.cut_application import _cut_copy, lay_pad_for_binding
from podcast_mcp.edits.decisions import edit_timeline_range
from podcast_mcp.edits.filler_pacing import filler_pad_mode
from podcast_mcp.engines.room_tone import TAKEN_WINDOW_SEC
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    EditDecision,
    EditDecisionType,
    EpisodeProject,
)
from podcast_mcp.util.batch_scope import batch_scope, unscoped

log = logging.getLogger(__name__)

Span = tuple[float, float]


def bindable(edit: EditDecision) -> bool:
    """Whether a pending ``edit`` lays a room-tone pad when it applies."""
    return (
        not edit.applied
        and edit.type == EditDecisionType.REMOVE
        and edit.exact_range is None
        and edit.timebase == "source"
        and edit.scope != "track"
        and (edit.replace_gap_sec or 0.0) > 0
    )


def bind_pending_pad_picks(project: EpisodeProject, *, defaults: EffectiveConfig) -> int:
    """Bind the room tone of every pending padded cut of ``project``; returns how many changed.

    A cut whose binding still answers its geometry and room-tone inputs plays it again and
    is left as it is; any other is picked afresh. A binding on a cut that no longer lays a
    pad is cleared. The pass is advisory: a cut it cannot lay on the copy stays as it was
    and its apply picks fresh.
    """
    padded = filler_pad_mode(defaults=defaults) == "room_tone"
    pending = [e for e in project.edit_decisions if padded and bindable(e)]
    pending_ids = {e.id for e in pending}
    changed = 0
    for edit in project.edit_decisions:
        if edit.bound_pad is not None and edit.id not in pending_ids:
            edit.bound_pad = None
            changed += 1
    if not pending:
        return changed
    ranges = _timeline_ranges(project, pending)
    working = _cut_copy(project)
    laid: set[str] = set()
    # Its own scope, like the idle warm's: nothing a trial parks there reaches a real batch.
    with unscoped(), batch_scope():
        for edit in sorted(pending, key=lambda e: e.start, reverse=True):
            try:
                lanes = lay_pad_for_binding(
                    working, edit, _promised(pending, ranges, edit, laid), defaults=defaults
                )
            except Exception:  # advisory: the apply picks fresh
                log.warning("pad pick not bound for %s", edit.id, exc_info=True)
                break
            laid.add(edit.id)
            bound = pad_binding.bind(edit, lanes)
            if bound != edit.bound_pad:
                edit.bound_pad = bound
                changed += 1
    return changed


def _timeline_ranges(
    project: EpisodeProject, pending: Sequence[EditDecision]
) -> dict[str, Span | None]:
    timeline = SessionTimeline(project)
    return {e.id: edit_timeline_range(project, e, timeline) for e in pending}


def _promised(
    pending: Sequence[EditDecision],
    ranges: dict[str, Span | None],
    edit: EditDecision,
    laid: set[str],
) -> dict[str, list[Span]]:
    """Source of the own audio that cuts near ``edit`` still to be laid will play from their bindings."""
    here = ranges.get(edit.id)
    promised: dict[str, list[Span]] = {}
    if here is None:
        return promised
    for other in pending:
        there = ranges.get(other.id)
        if other.id == edit.id or other.id in laid or there is None:
            continue
        if abs(there[0] - here[0]) > TAKEN_WINDOW_SEC:
            continue
        for track_id, lane in pad_binding.usable_lanes(other).items():
            if lane.kind == "own":
                promised.setdefault(track_id, []).append((lane.start, lane.end))
    return promised
