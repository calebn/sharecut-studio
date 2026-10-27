"""Reason-string vocabulary for generated tighten proposals.

Sound disposition and review policy live in ``cut_safety``. This leaf module
contains only reason parsing and detector vocabulary.
"""

from __future__ import annotations

ACOUSTIC_FILLER_REASON = "filler:acoustic"
# Suffixes on an acoustic proposal that say what the run may be: held for the editor like
# any other review flag (``:risky``, ``:other_speaking``), never dropped.
LIKELY_LAUGH_FLAG = "likely_laugh"
POSSIBLE_WORD_FLAG = "possible_word"
ACOUSTIC_KIND_FLAGS: tuple[str, ...] = (LIKELY_LAUGH_FLAG, POSSIBLE_WORD_FLAG)
REPETITION_REASON_PREFIX = "repetition:"
RESTART_REASON_PREFIX = "restart:"
PAUSE_REASON_PREFIX = "pause:"
OTHER_SPEAKING_FLAG = "other_speaking"


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
