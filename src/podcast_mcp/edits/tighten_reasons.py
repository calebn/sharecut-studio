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
PAUSE_REASON_PREFIX = "pause:"

# Generated proposals that must never auto-apply and must stay individually
# reviewable (never coalesced into a neighbouring cut, kept across re-proposal
# once a human applied them). A pause trim is one of them until the owner has listened
# to what it cuts (#1055): it waits for review whether or not its edges moved, and it
# never merges into a filler, a track-local cut or an NL cut beside it.
REVIEW_ONLY_REASON_PREFIXES: tuple[str, ...] = (
    ACOUSTIC_FILLER_REASON,
    REPETITION_REASON_PREFIX,
    RESTART_REASON_PREFIX,
    PAUSE_REASON_PREFIX,
)


def is_review_only_reason(reason: str | None) -> bool:
    """True for generated reasons that are proposal-only (see module docstring)."""
    return (reason or "").startswith(REVIEW_ONLY_REASON_PREFIXES)


def is_acoustic_filler_reason(reason: str | None) -> bool:
    """True for ``filler:acoustic`` proposals, including guard suffixes (``:risky``)."""
    return (reason or "").startswith(ACOUSTIC_FILLER_REASON)
