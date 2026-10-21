"""Read-only overlap report: time-overlapping word pairs across tracks with text-match hints."""

from __future__ import annotations

from bisect import bisect_left
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines.audio_audit import AnalysisPolicy, compute_word_audibility_map
from podcast_mcp.engines.lane_words import (
    WordKey,
    project_lane_transcripts,
    transcript_word_key,
    word_key,
)
from podcast_mcp.models import EpisodeProject, TranscriptWord
from podcast_mcp.util.progress import ProgressReporter
from podcast_mcp.util.wer import normalize_token


@dataclass(frozen=True)
class _ClockWord:
    """A word with its start and end on the session clock (``LaneTranscript``)."""

    key: WordKey
    word: TranscriptWord
    start: float
    end: float


def overlap_duplicate_report(
    project: EpisodeProject,
    *,
    start_sec: float | None = None,
    end_sec: float | None = None,
    policy: AnalysisPolicy | None = None,
    progress: ProgressReporter | None = None,
    audibility: list[dict[str, Any]] | None = None,
    is_suppressed: Callable[[WordKey], bool] | None = None,
    defaults: EffectiveConfig,
) -> dict[str, Any]:
    """Read-only: time-overlapping word pairs across tracks with text match hints.

    ``audibility`` is this project's ``compute_word_audibility_map`` when the caller already
    has it. ``is_suppressed(word_key)`` says which words to leave out of the pairs; the
    default reads each word's stored ``suppressed`` flag, and reconcile passes its own
    acoustic verdict so the pairs reflect the state it is about to write.

    Every recording placed on a lane takes part, each word named by its ``WordKey``
    (``source_a``/``source_b`` with ``word_index_a``/``word_index_b``) and compared on
    the session clock (``session_start_a``/``session_start_b``), since two takes on
    one lane each have their own source clock (#1470).
    """
    pol = policy or AnalysisPolicy.from_defaults(defaults=defaults)
    rows = (
        compute_word_audibility_map(project, policy=pol, progress=progress, defaults=defaults)
        if audibility is None
        else audibility
    )
    audibility_by_key = {word_key(row): row for row in rows}
    by_track: dict[str, list[_ClockWord]] = {}
    for lane in project_lane_transcripts(project):
        tr = lane.transcript
        words = by_track.setdefault(tr.track_id, [])
        for i, w in enumerate(tr.words):
            key = transcript_word_key(tr, i)
            suppressed = w.suppressed if is_suppressed is None else is_suppressed(key)
            if suppressed:
                continue
            span = lane.session_span(w.start, w.end)
            if span is None:
                continue
            start, end = span
            if start_sec is not None and start < start_sec:
                continue
            if end_sec is not None and start >= end_sec:
                continue
            words.append(_ClockWord(key, w, start, end))

    pairs: list[dict[str, Any]] = []
    track_ids = sorted(by_track)
    for ai, tid_a in enumerate(track_ids):
        for tid_b in track_ids[ai + 1 :]:
            # Preserve transcript order for equal-start output while excluding
            # words whose start or end cannot intersect the current A word.
            b_words = by_track[tid_b]
            b_starts = sorted((cw.start, pos) for pos, cw in enumerate(b_words))
            start_times = [start for start, _pos in b_starts]
            capacity = 1 << (max(1, len(b_starts)) - 1).bit_length()
            max_ends = [float("-inf")] * (2 * capacity)
            for order, (_start, pos) in enumerate(b_starts):
                max_ends[capacity + order] = b_words[pos].end
            for node in range(capacity - 1, 0, -1):
                max_ends[node] = max(max_ends[2 * node], max_ends[2 * node + 1])
            for a in by_track[tid_a]:
                stop = bisect_left(start_times, a.end)
                candidates: list[int] = []
                pending = [(1, 0, capacity)]
                while pending:
                    node, lo, hi = pending.pop()
                    if lo >= stop or max_ends[node] <= a.start:
                        continue
                    if hi - lo == 1:
                        candidates.append(b_starts[lo][1])
                        continue
                    mid = (lo + hi) // 2
                    pending.append((node * 2 + 1, mid, hi))
                    pending.append((node * 2, lo, mid))
                for pos in sorted(candidates):
                    b = b_words[pos]
                    w_a, w_b = a.word, b.word
                    if a.start >= b.end or b.start >= a.end:
                        continue
                    overlap = min(a.end, b.end) - max(a.start, b.start)
                    if overlap <= 0:
                        continue
                    tok_a = normalize_token(w_a.text)
                    tok_b = normalize_token(w_b.text)
                    text_match = tok_a == tok_b and bool(tok_a)
                    row_a = audibility_by_key.get(a.key, {})
                    row_b = audibility_by_key.get(b.key, {})
                    pairs.append(
                        {
                            "track_a": tid_a,
                            "source_a": a.key[1],
                            "word_index_a": a.key[2],
                            "text_a": w_a.text,
                            "start_a": w_a.start,
                            "end_a": w_a.end,
                            "status_a": row_a.get("audibility_status"),
                            "track_b": tid_b,
                            "source_b": b.key[1],
                            "word_index_b": b.key[2],
                            "text_b": w_b.text,
                            "start_b": w_b.start,
                            "end_b": w_b.end,
                            "session_start_a": a.start,
                            "session_start_b": b.start,
                            "status_b": row_b.get("audibility_status"),
                            "overlap_sec": round(overlap, 3),
                            "text_match": text_match,
                            "rms_a_db": row_a.get("own_rms_db"),
                            "rms_b_db": row_b.get("own_rms_db"),
                        }
                    )

    pairs.sort(key=lambda p: (p["session_start_a"], p["track_a"]))
    return {
        "pair_count": len(pairs),
        "text_match_count": sum(1 for p in pairs if p["text_match"]),
        "pairs": pairs,
    }
