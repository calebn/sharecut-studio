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


def _refuse_overlapping(targets: Sequence[ExactRangeTarget]) -> None:
    by_track: dict[str, list[tuple[float, float]]] = {}
    for target in targets:
        for track_id in target.track_ids:
            by_track.setdefault(track_id, []).extend((x.start, x.end) for x in target.intervals)
    for spans in by_track.values():
        spans.sort()
        reach = float("-inf")
        for start, end in spans:
            if reach > start:
                raise CodedValueError(
                    "Two targets cover the same audio on one track. Send each stretch once.",
                    code="overlapping_targets",
                )
            reach = max(reach, end)


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
    if not targets:
        raise CodedValueError("Send at least one target to edit.", code="no_targets")
    base_id = action_id or f"range_{uuid4().hex}"
    _refuse_overlapping(targets)
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
    used = {e.id for e in project.edit_decisions}
    for record in project.editorial.edit_log:
        used.update(record.decision_ids)
    taken = used & {e.id for e in edits}
    if taken:
        raise CodedValueError(
            f"Edit id {sorted(taken)[0]} is already used. Send a different command_id.",
            code="edit_id_taken",
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
