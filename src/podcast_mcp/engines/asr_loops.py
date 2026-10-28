"""Drop the repetition loop Whisper leaves in a final decode window.

When every fallback temperature fails faster-whisper's compression-ratio check, it keeps
the best failed attempt anyway. A loop there reaches us as hundreds of copies of one
phrase with timestamps stacked inside a fraction of a second, over audible audio, so the
silence filter has nothing to flag. More than ``MAX_WORDS_PER_WINDOW`` words in one
``DENSE_WINDOW_SEC`` is not speech. A dense cluster of at least ``MIN_LOOP_WORDS`` words
is dropped when its own text compresses like a loop (zlib, faster-whisper's formula) or
the decode window it came from stayed over the threshold. Dense words that read as
ordinary text are kept and counted, and repetition that is not dense is only counted.
Real words in the same window are never dropped, only the cluster.

The guard is a post-process on the model's output, so it is not part of
``AsrOptions.decode_key()``; ``read_asr_cache`` runs it too, so a cache written before it
existed is repaired when read.
"""

from __future__ import annotations

import logging
import math
import zlib
from collections.abc import Sequence
from dataclasses import dataclass

from podcast_mcp.models import DroppedAsrWord, Transcript, TranscriptWord

log = logging.getLogger(__name__)

# Sustained speech peaks near 6-8 words/s and the fastest bursts near 11; the Mac lab's
# loop put 147-221 words in 0.12 s.
DENSE_WINDOW_SEC = 1.0
MAX_WORDS_PER_WINDOW = 16
MIN_LOOP_WORDS = 12
COMPRESSION_RATIO_THRESHOLD = 2.4
MAX_DROPPED_WORDS_KEPT = 500
# A neighbour further than this from a cluster edge is speech beside it, not part of it.
CROWDED_GAP_SEC = DENSE_WINDOW_SEC / MAX_WORDS_PER_WINDOW


@dataclass(frozen=True)
class LoopReport:
    kept: list[TranscriptWord]
    dropped: list[TranscriptWord]
    dense_words: int = 0
    looped_segments: int = 0
    ratio: float | None = None


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


def _trim(starts: Sequence[float], lo: int, hi: int) -> tuple[int, int]:
    while hi - lo > 1 and starts[lo + 1] - starts[lo] > CROWDED_GAP_SEC:
        lo += 1
    while hi - lo > 1 and starts[hi - 1] - starts[hi - 2] > CROWDED_GAP_SEC:
        hi -= 1
    return lo, hi


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
    for lo, hi in (_trim(starts, *run) for run in _dense_runs(starts)):
        cluster = order[lo:hi]
        own = zlib_ratio(" ".join(words[i].text for i in cluster))
        window = max((r for i in cluster if (r := ratios[i]) is not None), default=None)
        looped = own >= COMPRESSION_RATIO_THRESHOLD or (
            window is not None and window > COMPRESSION_RATIO_THRESHOLD
        )
        if len(cluster) >= MIN_LOOP_WORDS and looped:
            dropped_at.update(cluster)
            zlib_peak = max(own, zlib_peak or 0.0)
        elif len(cluster) > 1:
            dense_words += len(cluster)
    over = {r for r in ratios if r is not None and r > COMPRESSION_RATIO_THRESHOLD}
    dropped_over = {ratios[i] for i in dropped_at}
    return LoopReport(
        kept=[w for i, w in enumerate(words) if i not in dropped_at],
        dropped=[w for i, w in enumerate(words) if i in dropped_at],
        dense_words=dense_words,
        looped_segments=len(over - dropped_over),
        ratio=zlib_peak,
    )


def guard_transcript(transcript: Transcript, window_ratios: Sequence[object] | None = None) -> None:
    """Drop looped words from ``transcript`` and record them on it; a second call is a no-op."""
    report = drop_looped_words(transcript.words, window_ratios)
    transcript.asr_dense_words = report.dense_words
    if window_ratios is not None:
        transcript.asr_looped_segments = report.looped_segments
    if not report.dropped:
        return
    transcript.words = report.kept
    room = MAX_DROPPED_WORDS_KEPT - len(transcript.asr_dropped_words)
    transcript.asr_dropped_words = [
        *transcript.asr_dropped_words,
        *(DroppedAsrWord(text=w.text, start=w.start, end=w.end) for w in report.dropped[:room]),
    ]
    transcript.asr_dropped_count += len(report.dropped)
    log.warning(
        "dropped %d looped word(s) at %.2f-%.2fs (zlib ratio %.1f)",
        len(report.dropped),
        min(w.start for w in report.dropped),
        max(w.end for w in report.dropped),
        report.ratio or 0.0,
    )
