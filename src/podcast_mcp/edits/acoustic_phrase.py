"""Short voiced hits strung together in one word gap are an untranscribed phrase.

A hit alone in a gap can be a filler. Several hits one after another, each separated
from the next by no more than this speaker's longest ordinary silence between one word
and the next, have the cadence of speech the transcript dropped, such as a hummed or sung
phrase. Muting them one by one would mute that phrase, so none is proposed.
"""

from __future__ import annotations

from collections.abc import Sequence
from itertools import pairwise

import numpy as np

from podcast_mcp.edits.acoustic_gap import AcousticGapRun
from podcast_mcp.models import TranscriptWord

MIN_STRING_HITS = 3
MIN_WORD_STEPS = 30
_SILENCE_PERCENTILE = 95.0


def word_silence_ceiling(words: Sequence[TranscriptWord], pause_sec: float) -> float | None:
    """This speaker's longest ordinary silence between words of one phrase.

    The 95th percentile of the silence from the end of one word to the start of the next,
    the same kind of quantity ``phrase_hit_indexes`` compares it with (the silence between
    voiced runs). Silences of ``pause_sec`` or more are a pause, not part of a phrase.
    ``None`` when the track has too few silences to read a cadence from. A speaker whose
    words abut has a ceiling near zero, so only hits that nearly touch chain into a phrase.
    """
    live = [w for w in words if not w.suppressed and w.end > w.start]
    silences = [
        nxt.start - word.end
        for word, nxt in pairwise(live)
        if 0.0 <= nxt.start - word.end < pause_sec
    ]
    if len(silences) < MIN_WORD_STEPS:
        return None
    return float(np.percentile(silences, _SILENCE_PERCENTILE))


def phrase_hit_indexes(runs: Sequence[AcousticGapRun], ceiling: float | None) -> set[int]:
    """Indexes of runs (in time order) that sit in a string of at least ``MIN_STRING_HITS``."""
    if ceiling is None:
        return set()
    members: set[int] = set()
    chain = [0] if runs else []
    for index in range(1, len(runs) + 1):
        if index < len(runs) and runs[index].start - runs[index - 1].end <= ceiling:
            chain.append(index)
            continue
        if len(chain) >= MIN_STRING_HITS:
            members.update(chain)
        chain = [index]
    return members
