"""Tighten hits: which pending decisions are tighten proposals, which are harsh, and which
are listened to one at a time.

The rules behind the Tighten list's harsh-only filter and its one-by-one marker (via
``pending_edits[].harsh`` and ``pending_edits[].listen_one_by_one``). Studio reads both flags
from the server and holds no rule of its own. Apply suggested actions does not filter on
them: the server applies each sound's own action and names what stays pending.

``why_line`` writes the plain sentence on a pending edit (``pending_edits[].why``) from the reason
code alone.
"""

from __future__ import annotations

import unicodedata
from typing import Any

from podcast_mcp.edits.cut_policy import review_kind, sound_kind
from podcast_mcp.edits.tighten_reasons import (
    PAUSE_REASON_PREFIX,
    RESTART_PARTIAL_REASON_PREFIX,
    pause_gap_sec,
    repeated_word,
)
from podcast_mcp.models import EditDecision


def is_tighten_reason(reason: str | None) -> bool:
    """True for pending tighten proposals."""
    return review_kind(reason) != "other"


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
    """A tighten hit that needs review or carries a join risk; the harsh-only filter lists it."""
    return is_tighten_reason(decision.reason) and (
        decision.review_required or join_risk_from_decision(decision) is not None
    )


def is_listen_one_by_one_hit(decision: EditDecision) -> bool:
    """A pause trim that stays for review: the editor listens to each and applies it alone.

    One that passed the risk checks is applied like a safe filler. Apply suggested actions
    leaves one whose join still needs review pending and names it.
    """
    return (decision.reason or "").startswith(PAUSE_REASON_PREFIX) and decision.review_required


MAX_QUOTED_CHARS = 24


def _plain(text: str | None) -> str | None:
    cleaned = "".join(ch for ch in text or "" if unicodedata.category(ch)[0] != "C").strip()
    if len(cleaned) > MAX_QUOTED_CHARS:
        cleaned = f"{cleaned[:MAX_QUOTED_CHARS]}…"
    return cleaned or None


def why_line(decision: EditDecision, *, speaker_name: str | None) -> str | None:
    """One short sentence saying why this edit is suggested, or ``None`` for no line."""
    if decision.author is not None:
        return None
    kind = sound_kind(decision.reason)
    name = _plain(speaker_name)
    if kind == "filler":
        return "Filler word"
    if kind == "pause":
        gap = pause_gap_sec(decision.reason)
        return None if gap is None else f"A {gap:.1f} s gap"
    if kind == "repetition":
        word = _plain(repeated_word(decision.reason))
        if word is None:
            return None
        return f"{name} says “{word}” twice" if name else f"“{word}” is said twice"
    if kind == "restart":
        if (decision.reason or "").startswith(RESTART_PARTIAL_REASON_PREFIX):
            return (
                f"{name} cuts off a word and says it again"
                if name
                else "A word is cut off and said again"
            )
        return f"{name} repeats a phrase" if name else "A phrase is repeated"
    if kind == "laugh":
        return "Might be a laugh; listen before cutting"
    if kind == "possible_word":
        return "Might be a word the transcript missed; listen before cutting"
    if kind == "acoustic":
        return "An unclear sound; listen before deciding"
    return None
