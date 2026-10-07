"""Tighten hits: which pending decisions are tighten proposals, and which are harsh.

The one eligibility rule for Studio **Apply eligible** (via ``pending_edits[].harsh``)
and the agent ``approve_edits_tool(apply_all_safe=True)`` / ``podcast edit approve
--all-safe`` twins.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from podcast_mcp.models import EditDecision

TIGHTEN_REASON_PREFIXES = ("filler:", "pause:", "repetition:", "restart:")


def is_tighten_reason(reason: str | None) -> bool:
    """True for pending tighten proposals."""
    text = reason or ""
    return text.startswith(TIGHTEN_REASON_PREFIXES)


def join_risk_from_decision(decision: EditDecision) -> dict[str, Any] | None:
    """View-only join risk from propose-time flags (no audio / no join sweep).

    ``EditService.join_quality`` is available per decision (MCP/CLI). The
    assembler does not score every snapshot — fail verdicts are already
    dropped when ``tighten.join_continuity_gate`` is on; review/risky stay
    on the decision as ``:join_review`` / ``:risky`` / ``review_required``.
    """
    reason = decision.reason or ""
    if not is_tighten_reason(reason):
        return None
    if ":risky" in reason:
        return {"verdict": "review", "label": "risky", "source": "reason", "risk": None}
    if ":join_review" in reason:
        return {
            "verdict": "review",
            "label": "join_review",
            "source": "reason",
            "risk": None,
        }
    return None


def is_harsh_tighten_hit(decision: EditDecision) -> bool:
    """A tighten hit that needs review or carries a join risk; Avoid harsh cuts skips it."""
    return is_tighten_reason(decision.reason) and (
        decision.review_required or join_risk_from_decision(decision) is not None
    )


def eligible_tighten_ids(decisions: Iterable[EditDecision]) -> list[str]:
    """Pending tighten hits that Apply eligible applies with Avoid harsh cuts on."""
    return [
        d.id
        for d in decisions
        if not d.applied and is_tighten_reason(d.reason) and not is_harsh_tighten_hit(d)
    ]
