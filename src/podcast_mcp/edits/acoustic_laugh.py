"""A laugh is a voiced run made of repeated level bursts, not a filler.

A hesitation ("uh", "um") holds one level: one burst. A laugh, a chuckle or a playful
"ha ha ha" is the voice switched on and off, each burst separated from the next by a dip
in level. Both measures are dB differences inside one run, so they read the same at any
recording level and need no calibration to the recording.

A run that looks like a laugh is still proposed, flagged ``likely_laugh`` for the editor.
Level bursts cannot tell a laugh from a false start or a sharp inhale, so this flags and
does not decide.
"""

from __future__ import annotations

import numpy as np

# Fewest bursts in a row that make a laugh. Matches the string length of
# ``acoustic_phrase.MIN_STRING_HITS``: two bursts are still "uh uh".
MIN_LAUGH_BURSTS = 3
# A dip separates two bursts when the level falls this far under the lower of the two
# bursts around it. A held vowel wanders about 3 dB frame to frame; twice that is a real gap.
BURST_DIP_DB = 6.0
# Bursts of one laugh are one voice at one effort: a burst whose peak is more than this far
# from the last one's starts another sound (a laugh does not step from a murmur to a shout).
BURST_STEP_DB = 12.0


def _burst_peaks(levels: np.ndarray) -> list[int]:
    """Frame indexes of each level burst in ``levels``, in order.

    A burst ends when the level falls :data:`BURST_DIP_DB` under its peak and the next
    begins when it climbs that far back over the valley between them.
    """
    peaks: list[int] = []
    if levels.size == 0:
        return peaks
    peak = valley = 0
    rising = True
    for index in range(1, levels.size):
        level = levels[index]
        if rising:
            if level > levels[peak]:
                peak = index
            elif levels[peak] - level >= BURST_DIP_DB:
                peaks.append(peak)
                rising, valley = False, index
        elif level < levels[valley]:
            valley = index
        elif level - levels[valley] >= BURST_DIP_DB:
            rising, peak = True, index
    if rising:
        peaks.append(peak)
    return peaks


def burst_count(levels: np.ndarray) -> int:
    """How many separate level bursts ``levels`` holds (:data:`BURST_DIP_DB` apart).

    One means a sound that rises, holds and falls once, like a sustained "uh"; several
    mean the voice switched on and off, as syllables, words and laughs do.
    """
    return len(_burst_peaks(levels))


def has_laugh_bursts(levels: np.ndarray) -> bool:
    """True when the run holds :data:`MIN_LAUGH_BURSTS` or more bursts in a row.

    Each burst's peak must lie within :data:`BURST_STEP_DB` of the one before.
    """
    streak = 0
    previous = None
    for index in _burst_peaks(levels):
        level = levels[index]
        streak = (
            streak + 1 if previous is not None and abs(level - previous) <= BURST_STEP_DB else 1
        )
        if streak >= MIN_LAUGH_BURSTS:
            return True
        previous = level
    return False
