"""The plain-language "why" line on a pending edit card.

Pure: reads a decision's reason code and recorded evidence, never audio or a project. Guest,
agent and manual edits have no line (the card omits it), and a reason it cannot read yields
none rather than an error.
"""

from __future__ import annotations

import re

from podcast_mcp.edits.cut_policy import sound_kind
from podcast_mcp.edits.tighten_reasons import OTHER_SPEAKING_FLAG
from podcast_mcp.models import EditDecision

_PAUSE_GAP = re.compile(r"^pause:(\d+(?:\.\d+)?)s(?::|$)")


def peers_speaking(decision: EditDecision) -> bool:
    """Whether the proposal found another speaker talking in the cut, from its recorded evidence."""
    return (
        decision.cut_speech is not None
        or decision.scope == "track"
        or OTHER_SPEAKING_FLAG in (decision.reason or "").split(":")
    )


def _quoted_token(reason: str) -> str | None:
    parts = reason.split(":")
    return parts[2].strip() or None if len(parts) > 2 else None


def _pause_line(decision: EditDecision) -> str | None:
    match = _PAUSE_GAP.match(decision.reason or "")
    if match is None:
        return None
    gap = float(match.group(1))
    retained = max(gap - (decision.end - decision.start), 0.0)
    return f"A {gap:.1f} s gap; keeps {retained:.1f} s"


def why_line(
    decision: EditDecision, *, speaker_name: str | None, peers_speaking: bool | None
) -> str | None:
    """One short sentence saying why this edit is suggested, or ``None`` for no line.

    ``peers_speaking`` is ``None`` when unknown; the "nobody talks over it" clause is added
    only when it is known to be ``False``.
    """
    kind = sound_kind(decision.reason)
    reason = decision.reason or ""
    if kind == "filler":
        return "Filler word; the sentence reads the same without it"
    if kind == "pause":
        return _pause_line(decision)
    if kind == "repetition":
        token = _quoted_token(reason)
        if token is None:
            return None
        return (
            f"{speaker_name} says “{token}” twice" if speaker_name else f"“{token}” is said twice"
        )
    if kind == "restart":
        line = f"{speaker_name} restarts the sentence" if speaker_name else "The sentence restarts"
        return f"{line}; nobody talks over it" if peers_speaking is False else line
    if kind == "laugh":
        return "Sounds like a laugh, not a word"
    if kind == "possible_word":
        return "Might be a word the transcript missed; listen before cutting"
    if kind == "acoustic":
        return "An unclear sound; listen before deciding"
    return None
