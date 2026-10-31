"""Drop the repetition loop Whisper leaves in a final decode window.

When every fallback temperature fails faster-whisper's compression-ratio check, it keeps
the best failed attempt anyway. A loop there reaches us as hundreds of copies of one
phrase with timestamps stacked inside a fraction of a second, over audible audio, so the
silence filter has nothing to flag.

More than ``MAX_WORDS_PER_WINDOW`` words starting inside one ``DENSE_WINDOW_SEC`` is not
speech. Such a dense stretch is split wherever two consecutive word starts are more than
``CROWDED_GAP_SEC`` apart, and each squeezed run is judged on its own: a run of at least
``MIN_LOOP_WORDS`` words is dropped when its own text compresses like a loop (zlib,
faster-whisper's formula, at least ``COMPRESSION_RATIO_THRESHOLD``) or when the decode
window it came from reported a ``compression_ratio`` over that fixed threshold. The window
test does not look at the text, so it also drops a dense run of ordinary words. Words
outside the squeezed runs are kept, even inside the same window. A word whose start lies
inside a run, or at most ``CROWDED_GAP_SEC`` before its first word, cannot be told from
the loop and goes with it. Dense runs that are kept are counted, and so are
over-threshold windows that dropped nothing.

The guard is a post-process on the model's output, so it is not part of
``AsrOptions.decode_key()``. ``read_asr_cache`` runs it too, without window ratios (a
cache holds none), so a cache that already holds a loop gets the own-text test only and
its words are dropped on every read; the cache file is not rewritten.
"""

from __future__ import annotations

import logging
import math
import zlib
from collections.abc import Sequence
from dataclasses import dataclass

from podcast_mcp.models import Transcript, TranscriptWord
from podcast_mcp.models.words_revision import set_words

log = logging.getLogger(__name__)

# Sustained speech peaks near 6-8 words/s and the fastest bursts near 11.
DENSE_WINDOW_SEC = 1.0
MAX_WORDS_PER_WINDOW = 16
MIN_LOOP_WORDS = 12
COMPRESSION_RATIO_THRESHOLD = 2.4
# Consecutive words further apart than this are not squeezed together.
CROWDED_GAP_SEC = DENSE_WINDOW_SEC / MAX_WORDS_PER_WINDOW
# Words of one over-threshold ratio further apart than this belong to separate windows.
WINDOW_GAP_SEC = 5.0


@dataclass(frozen=True)
class LoopReport:
    kept: list[TranscriptWord]
    dropped: list[TranscriptWord]
    dense_words: int = 0
    looped_segments: int = 0
    ratio: float | None = None

    @property
    def start(self) -> float | None:
        return min((w.start for w in self.dropped), default=None)

    @property
    def end(self) -> float | None:
        return max((w.end for w in self.dropped), default=None)


def zlib_ratio(text: str) -> float:
    data = text.encode("utf-8")
    return len(data) / len(zlib.compress(data)) if data else 0.0


def _real_ratio(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return None
    return float(value)


def _dense_runs(starts: Sequence[float]) -> list[tuple[int, int]]:
    """Index ranges of words that lie in a window holding more than the allowed count."""
    runs: list[tuple[int, int]] = []
    end = 0
    for first in range(len(starts)):
        end = max(end, first)
        while end < len(starts) and starts[end] - starts[first] < DENSE_WINDOW_SEC:
            end += 1
        if end - first <= MAX_WORDS_PER_WINDOW:
            continue
        if runs and first <= runs[-1][1]:
            runs[-1] = (runs[-1][0], end)
        else:
            runs.append((first, end))
    return runs


def _squeezed_runs(starts: Sequence[float], lo: int, hi: int) -> list[tuple[int, int]]:
    """Split ``[lo, hi)`` wherever consecutive starts are more than ``CROWDED_GAP_SEC`` apart."""
    runs: list[tuple[int, int]] = []
    first = lo
    for i in range(lo + 1, hi):
        if starts[i] - starts[i - 1] > CROWDED_GAP_SEC:
            runs.append((first, i))
            first = i
    runs.append((first, hi))
    return runs


def _windows(
    order: Sequence[int], starts: Sequence[float], ratios: Sequence[float | None]
) -> list[list[int]]:
    """Groups of word indices that share one over-threshold window ratio, in time order."""
    windows: list[list[int]] = []
    previous: int | None = None
    for pos, i in enumerate(order):
        ratio = ratios[i]
        if ratio is None or ratio <= COMPRESSION_RATIO_THRESHOLD:
            previous = None
            continue
        if (
            previous is not None
            and ratios[order[previous]] == ratio
            and starts[pos] - starts[previous] <= WINDOW_GAP_SEC
        ):
            windows[-1].append(i)
        else:
            windows.append([i])
        previous = pos
    return windows


def drop_looped_words(
    words: Sequence[TranscriptWord], window_ratios: Sequence[object] | None = None
) -> LoopReport:
    """Split ``words`` into kept and dropped.

    ``window_ratios`` holds, per word, the compression ratio of the decode window it came
    from; anything that is not a real number is ignored.
    """
    order = sorted(range(len(words)), key=lambda i: words[i].start)
    starts = [words[i].start for i in order]
    ratios = [_real_ratio(r) for r in window_ratios or [None] * len(words)]
    dropped_at: set[int] = set()
    dense_words = 0
    zlib_peak: float | None = None
    for dense in _dense_runs(starts):
        for lo, hi in _squeezed_runs(starts, *dense):
            run = order[lo:hi]
            own = zlib_ratio(" ".join(words[i].text for i in run))
            window = max((r for i in run if (r := ratios[i]) is not None), default=None)
            looped = own >= COMPRESSION_RATIO_THRESHOLD or (
                window is not None and window > COMPRESSION_RATIO_THRESHOLD
            )
            if len(run) >= MIN_LOOP_WORDS and looped:
                dropped_at.update(run)
                zlib_peak = max(own, zlib_peak or 0.0)
            elif len(run) > 1:
                dense_words += len(run)
    looped_windows = sum(
        1 for window in _windows(order, starts, ratios) if dropped_at.isdisjoint(window)
    )
    return LoopReport(
        kept=[w for i, w in enumerate(words) if i not in dropped_at],
        dropped=[w for i, w in enumerate(words) if i in dropped_at],
        dense_words=dense_words,
        looped_segments=looped_windows,
        ratio=zlib_peak,
    )


def guard_transcript(
    transcript: Transcript, window_ratios: Sequence[object] | None = None
) -> LoopReport | None:
    """Drop looped words from ``transcript``; None when there was nothing to report."""
    report = drop_looped_words(transcript.words, window_ratios)
    if not (report.dropped or report.dense_words or report.looped_segments):
        return None
    if report.dropped:
        set_words(transcript, report.kept)
        log.warning(
            "dropped %d looped word(s) at %.2f-%.2fs (zlib ratio %.1f)",
            len(report.dropped),
            report.start,
            report.end,
            report.ratio or 0.0,
        )
    return report
