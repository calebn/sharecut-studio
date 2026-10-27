"""Reason-string vocabulary for generated tighten proposals.

Sound disposition and review policy live in ``cut_safety``. This leaf module
contains only reason parsing and detector vocabulary.
"""

from __future__ import annotations

import re

ACOUSTIC_FILLER_REASON = "filler:acoustic"
# Suffixes on an acoustic proposal that say what the run may be: held for the editor like
# any other review flag (``:risky``, ``:other_speaking``), never dropped.
LIKELY_LAUGH_FLAG = "likely_laugh"
POSSIBLE_WORD_FLAG = "possible_word"
ACOUSTIC_KIND_FLAGS: tuple[str, ...] = (LIKELY_LAUGH_FLAG, POSSIBLE_WORD_FLAG)
REPETITION_REASON_PREFIX = "repetition:"
RESTART_REASON_PREFIX = "restart:"
PAUSE_REASON_PREFIX = "pause:"
REPEATED_WORD_REASON_PREFIX = f"{REPETITION_REASON_PREFIX}word:"
# Suffixes the proposer appends after a reason's own fields; the repeated word ends where one begins.
_REASON_FLAGS = frozenset(
    {
        "risky",
        "join_review",
        "voiced_edge",
        "air_edges",
        "other_speaking",
        "acoustic_review",
        LIKELY_LAUGH_FLAG,
        POSSIBLE_WORD_FLAG,
    }
)
_PAUSE_GAP = re.compile(r"^pause:(\d+(?:\.\d+)?)s(?::|$)")


def pause_gap_sec(reason: str | None) -> float | None:
    """The timeline-measured gap a ``pause:2.90s[:solo]`` reason records; None if unreadable."""
    match = _PAUSE_GAP.match(reason or "")
    return float(match.group(1)) if match else None


def repeated_word(reason: str | None) -> str | None:
    """The word of a ``repetition:word:<word>[:flags]`` reason; None if unreadable."""
    text = reason or ""
    if not text.startswith(REPEATED_WORD_REASON_PREFIX):
        return None
    parts: list[str] = []
    for part in text[len(REPEATED_WORD_REASON_PREFIX) :].split(":"):
        if part in _REASON_FLAGS:
            break
        parts.append(part)
    return ":".join(parts) or None


def is_acoustic_filler_reason(reason: str | None) -> bool:
    """True for ``filler:acoustic`` proposals, including guard suffixes (``:risky``)."""
    return (reason or "").startswith(ACOUSTIC_FILLER_REASON)


def has_acoustic_kind_flag(reason: str | None, flag: str) -> bool:
    """True for an acoustic proposal whose reason carries the ``flag`` suffix."""
    return is_acoustic_filler_reason(reason) and flag in (reason or "").split(":")[2:]


def is_likely_laugh_reason(reason: str | None) -> bool:
    """True for an acoustic proposal flagged as a likely laugh."""
    return has_acoustic_kind_flag(reason, LIKELY_LAUGH_FLAG)


def is_possible_word_reason(reason: str | None) -> bool:
    """True for an acoustic proposal flagged as a possible missed word."""
    return has_acoustic_kind_flag(reason, POSSIBLE_WORD_FLAG)
