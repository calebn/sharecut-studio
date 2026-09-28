from __future__ import annotations

# #715: measured against the shipped forced-alignment pass (LibriSpeech, 3 clips,
# scored, plus a 3x60s real-speech lab sample; see docs/testing.md "Shipped pass
# results (#715)"). Rule fixed before measuring: L = longest aligned word (0.76 s)
# + worst |duration error| vs gold (0.22 s) = 0.98 s; keep 2.0 s because L + 0.5 <=
# 2.0. Never lower this: it also gates the aligner-off path and the audibility /
# bleed / precorrect checks, nothing measured supports a lower value for unaligned
# words, and real long words run 1-1.5 s.
DEFAULT_MAX_WORD_DURATION_SEC = 2.0
ANOMALOUS_WORD_DURATION_REASON = "anomalous_word_duration"


def word_duration_is_anomalous(
    duration_sec: float,
    max_sec: float = DEFAULT_MAX_WORD_DURATION_SEC,
) -> bool:
    """True when an ASR token is longer than the audibility / rewrite cap."""
    return max_sec > 0 and duration_sec > max_sec
