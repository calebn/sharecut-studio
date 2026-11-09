from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal, TypedDict
from uuid import uuid4

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.cut_application import apply_ranges, assess_offer
from podcast_mcp.edits.range_target import resolve_range
from podcast_mcp.models import (
    CutIntent,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    ProposalOrigin,
)
from podcast_mcp.models.episode import ExactRangeTarget
from podcast_mcp.util.coded_error import CodedValueError

RangeAction = Literal["cut", "mute"]


class RangeEditResult(TypedDict):
    action_ids: list[str]
    proposed: bool
    edits: list[dict[str, Any]]


def edit_selected_range(
    project: EpisodeProject,
    targets: Sequence[ExactRangeTarget],
    action: RangeAction,
    *,
    propose: bool,
    reason: str,
    action_id: str,
    author: str | None = None,
    boundary_intent: CutIntent = CutIntent.PROGRAMMATIC,
    defaults: EffectiveConfig,
) -> RangeEditResult:
    """Cut or mute every target in one pass, so the caller's mutation is one history step.

    Each target is one speaker's track set. Ids are ``action_id`` then ``action_id:1``,
    ``action_id:2`` so a retried command reuses them.
    """
    base_id = action_id or f"range_{uuid4().hex}"
    edits: list[EditDecision] = []
    for n, target in enumerate(targets):
        if propose:
            target = resolve_range(project, target)
        if not target.clips:
            raise CodedValueError(
                "No audible media in this range. Select a range that contains audio.",
                code="no_audible_media",
            )
        edits.append(
            EditDecision(
                id=base_id if n == 0 else f"{base_id}:{n}",
                track_id="",
                track_ids=target.track_ids,
                type=EditDecisionType.REMOVE if action == "cut" else EditDecisionType.MUTE,
                start=target.intervals[0].start,
                end=target.intervals[-1].end,
                timebase="timeline",
                scope="selected_tracks",
                review_required=propose,
                applied=False,
                reason=reason,
                author=author,
                exact_range=target,
                proposal_origin=(
                    ProposalOrigin.HUMAN
                    if boundary_intent is CutIntent.HUMAN_BOUNDARIES
                    else ProposalOrigin.PROGRAMMATIC
                ),
                boundary_intent=boundary_intent,
            )
        )
    if propose:
        for edit in edits:
            holds = assess_offer(project, edit, defaults=defaults)
            if holds:
                edit.reason = (
                    f"{edit.reason}:acoustic_review:{','.join(h.detail or h.reason for h in holds)}"
                )
                edit.review_required = True
        project.edit_decisions.extend(edits)
    else:
        apply_ranges(project, edits, defaults=defaults)
    return {
        "action_ids": [e.id for e in edits],
        "proposed": propose,
        "edits": [e.model_dump(mode="json") for e in edits],
    }
