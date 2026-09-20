from __future__ import annotations

DEFAULT_MAX_WORD_DURATION_SEC = 2.0
ANOMALOUS_WORD_DURATION_REASON = "anomalous_word_duration"


def word_duration_is_anomalous(
    duration_sec: float,
    max_sec: float = DEFAULT_MAX_WORD_DURATION_SEC,
) -> bool:
    """True when an ASR token is longer than the audibility / rewrite cap."""
    return max_sec > 0 and duration_sec > max_sec
