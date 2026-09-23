"""Reason-string vocabulary for generated tighten proposals.

Single source of truth for which generated reasons are review-only, so the
proposer, re-proposal pruning, coalescing, and audition hypotheses cannot drift
apart.  Leaf module (no project imports) so low-level edit helpers such as
``transcript_cuts`` can depend on it without import cycles.
"""

from __future__ import annotations

ACOUSTIC_FILLER_REASON = "filler:acoustic"
REPETITION_REASON_PREFIX = "repetition:"
RESTART_REASON_PREFIX = "restart:"

# Generated proposals that must never auto-apply and must stay individually
# reviewable (never coalesced into a neighbouring cut, kept across re-proposal
# once a human applied them).
REVIEW_ONLY_REASON_PREFIXES: tuple[str, ...] = (
    ACOUSTIC_FILLER_REASON,
    REPETITION_REASON_PREFIX,
    RESTART_REASON_PREFIX,
)


def is_review_only_reason(reason: str | None) -> bool:
    """True for generated reasons that are proposal-only (see module docstring)."""
    return (reason or "").startswith(REVIEW_ONLY_REASON_PREFIXES)


def is_acoustic_filler_reason(reason: str | None) -> bool:
    """True for ``filler:acoustic`` proposals, including guard suffixes (``:risky``)."""
    return (reason or "").startswith(ACOUSTIC_FILLER_REASON)
