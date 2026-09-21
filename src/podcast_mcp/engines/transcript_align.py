from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from podcast_mcp.models import TranscriptsSection
from podcast_mcp.util.wer import normalize_token

log = logging.getLogger(__name__)


@dataclass
class TranscriptAlignResult:
    offset_sec: float
    overlap_sec: float
    overlap_at_zero_sec: float
    method: str = "unknown"
    anchor_detail: str | None = None


@dataclass
class WordToken:
    text: str
    start: float
    end: float
    confidence: float


def speech_intervals(
    words: list[WordToken],
    *,
    min_confidence: float = 0.5,
    max_gap_sec: float = 1.5,
) -> list[tuple[float, float]]:
    filtered = [
        (w.start, w.end) for w in words if w.confidence >= min_confidence and w.end > w.start
    ]
    if not filtered:
        return []
    filtered.sort(key=lambda x: x[0])
    intervals: list[tuple[float, float]] = []
    cur_s, cur_e = filtered[0]
    for s, e in filtered[1:]:
        if s - cur_e <= max_gap_sec:
            cur_e = max(cur_e, e)
        else:
            intervals.append((cur_s, cur_e))
            cur_s, cur_e = s, e
    intervals.append((cur_s, cur_e))
    return intervals


def overlap_duration(
    a: list[tuple[float, float]],
    b: list[tuple[float, float]],
) -> float:
    """Sweep-line overlap of two interval lists (sorted copies)."""
    aa = sorted(a, key=lambda x: x[0])
    bb = sorted(b, key=lambda x: x[0])
    total = 0.0
    i = 0
    j = 0
    while i < len(aa) and j < len(bb):
        as_, ae = aa[i]
        bs, be = bb[j]
        lo, hi = max(as_, bs), min(ae, be)
        if hi > lo:
            total += hi - lo
        if ae < be:
            i += 1
        else:
            j += 1
    return total


def _first_phrase_before(
    words: list[WordToken],
    phrase: str,
    before_sec: float | None,
) -> tuple[float, float] | None:
    if before_sec is None:
        return find_phrase_interval(words, phrase)
    needle = re.sub(r"\s+", " ", phrase.lower().strip())
    for w in words:
        if w.confidence < 0.5 or w.start > before_sec:
            continue
        if needle in normalize_token(w.text) and w.end > w.start:
            return (w.start, w.end)
    return find_phrase_interval(
        [w for w in words if before_sec is None or w.start <= before_sec],
        phrase,
    )


def find_phrase_interval(
    words: list[WordToken],
    phrase: str,
    *,
    min_confidence: float = 0.5,
) -> tuple[float, float] | None:
    """Return (start, end) of first match for phrase across consecutive words."""
    needle = re.sub(r"\s+", " ", phrase.lower().strip())
    if not needle:
        return None
    parts = [normalize_token(w.text) for w in words if w.confidence >= min_confidence]
    times: list[tuple[float, float]] = [
        (w.start, w.end) for w in words if w.confidence >= min_confidence
    ]
    if len(parts) != len(times):
        return None
    n = len(needle.split())
    if not n:
        return None
    for i in range(len(parts) - n + 1):
        window = " ".join(p for p in parts[i : i + n] if p)
        if needle in window or window in needle:
            start, end = times[i][0], times[i + n - 1][1]
            if end > start:
                return (start, end)
    for w in words:
        if w.confidence >= min_confidence and needle in normalize_token(w.text) and w.end > w.start:
            return (w.start, w.end)
    return None


def offset_from_anchor(
    reference: list[WordToken],
    source: list[WordToken],
    *,
    reference_contains: str,
    source_contains: str,
    gap_sec: float = 1.0,
    align_to: str = "after_reference",
    search_before_sec: float | None = None,
) -> TranscriptAlignResult | None:
    """
    Align source so ``source_contains`` follows ``reference_contains`` on the session clock.

    Positive offset = source plays later on the session timeline (same as session_offset_sec).
    """
    ref_hit = _first_phrase_before(reference, reference_contains, search_before_sec)
    src_hit = _first_phrase_before(source, source_contains, search_before_sec)
    if not ref_hit or not src_hit:
        return None
    ref_s, ref_e = ref_hit
    src_s, src_e = src_hit
    if align_to == "after_reference":
        target_src_start = ref_e + gap_sec
        offset = target_src_start - src_s
    else:
        offset = ref_s - src_s
    at_zero = overlap_duration(
        speech_intervals(reference),
        speech_intervals(source),
    )
    shifted = [(s + offset, e + offset) for s, e in speech_intervals(source)]
    return TranscriptAlignResult(
        offset_sec=offset,
        overlap_sec=overlap_duration(speech_intervals(reference), shifted),
        overlap_at_zero_sec=at_zero,
        method="anchor",
        anchor_detail=(
            f"ref '{reference_contains}' @{ref_s:.2f}-{ref_e:.2f}s → "
            f"src '{source_contains}' @{src_s:.2f}-{src_e:.2f}s, gap={gap_sec}s"
        ),
    )


def interval_duration(intervals: list[tuple[float, float]]) -> float:
    return sum(e - s for s, e in intervals)


def raise_if_cancelled(cancel_check: Callable[[], bool] | None) -> None:
    if cancel_check is not None and cancel_check():
        raise RuntimeError("Pipeline cancelled")


def turn_taking_score_at(
    reference: list[tuple[float, float]],
    source: list[tuple[float, float]],
    offset_sec: float,
) -> tuple[float, float]:
    """Return ``(score, overlap_sec)`` for source islands shifted by offset."""
    if not reference or not source:
        return 0.0, 0.0
    shifted = [(s + offset_sec, e + offset_sec) for s, e in source]
    both = overlap_duration(reference, shifted)
    solo = interval_duration(reference) + interval_duration(source) - 2 * both
    return solo - 2.0 * both - 0.2 * abs(offset_sec), both


def offset_turn_taking_score(
    reference: list[tuple[float, float]],
    source: list[tuple[float, float]],
    *,
    max_offset_sec: float = 60.0,
    step_sec: float = 0.5,
    cancel_check: Callable[[], bool] | None = None,
) -> TranscriptAlignResult:
    """Prefer offsets with less simultaneous speech; cap search so content stays in-window.

    Large bounds use a hierarchical coarse sweep so hour-scale files are not a
    linear 0.5s walk of the full span.
    """
    ref = reference
    src = source
    if not ref or not src:
        return TranscriptAlignResult(0.0, 0.0, 0.0, method="turn_taking")
    at_zero = overlap_duration(ref, src)

    def score_at(offset: float) -> tuple[float, float]:
        raise_if_cancelled(cancel_check)
        return turn_taking_score_at(ref, src, offset)

    best_offset = 0.0
    best_score, best_overlap = score_at(0.0)

    def consider(offset: float) -> None:
        nonlocal best_offset, best_score, best_overlap
        score, both = score_at(offset)
        if score > best_score:
            best_score = score
            best_offset = offset
            best_overlap = both

    linear_steps = int(max_offset_sec / step_sec) if step_sec > 0 else 0
    if linear_steps <= 240:
        for i in range(-linear_steps, linear_steps + 1):
            consider(i * step_sec)
    else:
        # Sample through the current center (identity on stage 1) so peaks like
        # +8.0s stay on the grid. Anchoring at -max_offset with step 8 misses
        # those offsets when max_offset is not a multiple of the stage step.
        log.debug(
            "turn_taking hierarchical max_offset=%.3f step=%.3f linear_steps=%d",
            max_offset_sec,
            step_sec,
            linear_steps,
        )
        center = 0.0
        span = max_offset_sec
        for stage_step in (max(step_sec * 16, 8.0), max(step_sec * 4, 2.0), step_sec):
            kmax = max(0, int(span / stage_step + 1e-12))
            stage_best = center
            stage_score = float("-inf")
            for k in range(-kmax, kmax + 1):
                offset = center + k * stage_step
                if abs(offset) > max_offset_sec + 1e-12:
                    continue
                sc, both = score_at(offset)
                if sc > stage_score:
                    stage_score = sc
                    stage_best = offset
                if sc > best_score:
                    best_score = sc
                    best_offset = offset
                    best_overlap = both
            log.debug(
                "turn_taking stage step=%.3f center=%.3f kmax=%d best=%.3f score=%.2f",
                stage_step,
                center,
                kmax,
                stage_best,
                stage_score,
            )
            center = stage_best
            span = stage_step * 2
        log.debug(
            "turn_taking hierarchical done best_offset=%.3f best_score=%.2f",
            best_offset,
            best_score,
        )
    return TranscriptAlignResult(
        best_offset,
        best_overlap,
        at_zero,
        method="turn_taking",
    )


def load_transcripts(path: Path) -> dict[str, list[WordToken]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if "per_track" in data:
        section = TranscriptsSection.model_validate({"per_track": data["per_track"]})
    else:
        section = TranscriptsSection.model_validate(data)
    out: dict[str, list[WordToken]] = {}
    for tr in section.per_track:
        out[tr.track_id] = [
            WordToken(
                text=w.text,
                start=w.start,
                end=w.end,
                confidence=w.confidence if w.confidence is not None else 1.0,
            )
            for w in tr.words
        ]
    return out


def cross_speaker_offsets_from_transcripts(
    speaker_track_ids: list[tuple[str, str]],
    words_by_track: dict[str, list[WordToken]],
    *,
    anchors: list[dict] | None = None,
    max_offset_sec: float = 60.0,
    step_sec: float = 0.5,
    min_confidence: float = 0.5,
) -> dict[str, TranscriptAlignResult]:
    if not speaker_track_ids:
        return {}
    ref_name, ref_tid = speaker_track_ids[0]
    ref_words = words_by_track.get(ref_tid, [])
    ref_intervals = speech_intervals(ref_words, min_confidence=min_confidence)
    results: dict[str, TranscriptAlignResult] = {
        ref_name: TranscriptAlignResult(0.0, 0.0, 0.0, method="reference"),
    }
    for name, tid in speaker_track_ids[1:]:
        src_words = words_by_track.get(tid, [])
        src_intervals = speech_intervals(src_words, min_confidence=min_confidence)
        applied: TranscriptAlignResult | None = None
        if anchors:
            for anchor in anchors:
                if anchor.get("source_speaker") != name:
                    continue
                ref_sp = anchor.get("reference_speaker", ref_name)
                if ref_sp != ref_name:
                    continue
                align_to = anchor.get("align_to", "after_reference")
                align_mode = "start" if align_to == "start" else "after_reference"
                applied = offset_from_anchor(
                    ref_words,
                    src_words,
                    reference_contains=anchor["reference_contains"],
                    source_contains=anchor["source_contains"],
                    gap_sec=float(anchor.get("gap_sec", 1.0)),
                    align_to=align_mode,
                )
                if applied:
                    break
        if applied:
            results[name] = applied
        else:
            results[name] = offset_turn_taking_score(
                ref_intervals,
                src_intervals,
                max_offset_sec=max_offset_sec,
                step_sec=step_sec,
            )
    return results
