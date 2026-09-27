"""Flag ASR words that sit over digital silence (issue #521).

Whisper sometimes invents text over silent stretches. A word whose own-track
peak is below a very low floor cannot have been spoken on that track, so it is
marked ``suspect_hallucination``. Words are never deleted or retimed.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from pathlib import Path

import numpy as np

from podcast_mcp.models import TranscriptWord

log = logging.getLogger(__name__)

# Coarse rate is plenty for a peak test and keeps the decode cheap.
SILENCE_SAMPLE_RATE = 8000
MIN_SPAN_SEC = 0.05


def flag_words_over_silence(
    words: Sequence[TranscriptWord],
    samples: np.ndarray,
    sr: int,
    *,
    peak_dbfs: float,
) -> int:
    """Set ``suspect_hallucination`` on every word; return how many are True."""
    floor = 10.0 ** (peak_dbfs / 20.0)
    total = int(samples.size)
    flagged = 0
    for w in words:
        w.suspect_hallucination = False
        centre = (w.start + w.end) / 2.0
        half = max(w.end - w.start, MIN_SPAN_SEC) / 2.0
        lo = max(0, int((centre - half) * sr))
        hi = min(total, int(np.ceil((centre + half) * sr)))
        if lo >= hi:
            continue  # span outside the decoded audio: no evidence either way
        if float(np.max(np.abs(samples[lo:hi]))) < floor:
            w.suspect_hallucination = True
            flagged += 1
    return flagged


def flag_silent_words_in_file(
    words: Sequence[TranscriptWord],
    path: Path,
    *,
    peak_dbfs: float,
) -> int | None:
    """Decode ``path`` and flag silent words; ``None`` when the audio cannot be decoded."""
    from podcast_mcp.engines.audio_audit import load_mono_full

    try:
        samples = load_mono_full(path, sample_rate=SILENCE_SAMPLE_RATE)
    except Exception as exc:
        log.debug("silence filter skipped for %s: %s", path, exc)
        return None
    return flag_words_over_silence(words, samples, SILENCE_SAMPLE_RATE, peak_dbfs=peak_dbfs)
