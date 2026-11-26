"""Pending remove/mute suggestion mutation for EditService.suggest_pending_edit."""

from collections.abc import Callable
from typing import Any, cast

from podcast_mcp.edits.edit_reasons import GUEST_SUGGEST_REASON
from podcast_mcp.edits.transcript_cuts import append_remove_decision
from podcast_mcp.models import EditDecisionType
from podcast_mcp.services.document.edit_wire_results import SuggestedEdit
from podcast_mcp.util.coded_error import CodedValueError


def suggest_mutation(
    defaults: Callable[[], dict[str, Any]],
    track_id: str,
    start: float,
    end: float,
    *,
    reason: str | None,
    edit_type: str | None,
    author: str | None,
) -> Callable[..., SuggestedEdit]:
    """Validate edit_type and return the project mutation that appends the pending decision."""
    raw = str(edit_type or "remove").strip().lower()
    if raw not in ("remove", "mute"):
        raise CodedValueError("edit_type must be remove or mute", code="edit_type_invalid")
    decision_type = EditDecisionType.MUTE if raw == "mute" else EditDecisionType.REMOVE

    def mutate(p) -> SuggestedEdit:
        decision = append_remove_decision(
            p,
            track_id,
            float(start),
            float(end),
            reason=reason or GUEST_SUGGEST_REASON,
            review_required=True,
            decision_type=decision_type,
            author=author,
            defaults=defaults(),
        )
        return cast(SuggestedEdit, decision.model_dump(exclude={"bound_pad"}))

    return mutate
