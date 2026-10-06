"""Reason codes stamped on pending edits proposed by guests and agents.

Leaf module (no project imports). The DAW names each code in words
(``gui/web/src/utils/pendingEditLabels.ts``); ``tests/test_edit_reasons.py``
fails when a code here has no label there.
"""

from __future__ import annotations

GUEST_SUGGEST_REASON = "guest:suggest"
GUEST_SUGGEST_SPLIT_REASON = "guest:suggest_split"
GUEST_SUGGEST_DELETE_REASON = "guest:suggest_delete"
GUEST_SUGGEST_RIPPLE_DELETE_REASON = "guest:suggest_ripple_delete"
NL_RANGE_REASON = "nl:range"
NL_MANUAL_REASON = "nl:manual"
NL_WORDS_REASON = "nl:words"
NL_MATCH_REASON_PREFIX = "nl:match:"
NL_UTTERANCE_REASON_PREFIX = "nl:utterance:"

LABELLED_REASON_CODES: tuple[str, ...] = (
    GUEST_SUGGEST_REASON,
    GUEST_SUGGEST_SPLIT_REASON,
    GUEST_SUGGEST_DELETE_REASON,
    GUEST_SUGGEST_RIPPLE_DELETE_REASON,
    NL_RANGE_REASON,
    NL_MANUAL_REASON,
    NL_WORDS_REASON,
)
LABELLED_REASON_PREFIXES: tuple[str, ...] = (NL_MATCH_REASON_PREFIX, NL_UTTERANCE_REASON_PREFIX)
