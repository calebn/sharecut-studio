"""Conversation-clock alignment from ASR bleed phrases and own-speech gaps.

Places whole-file dialogue clips on one session timeline. Does not blade or
split media — one raw file remains one clip.
"""

from __future__ import annotations

import hashlib
import itertools
import logging
import re
import statistics
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from podcast_mcp.edits.ranges import merge_timeline_ranges
from podcast_mcp.edits.track_media import refresh_timeline_duration
from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
from podcast_mcp.engines.transcript_align import (
    WordToken,
    offset_turn_taking_score,
    raise_if_cancelled,
    speech_intervals,
    turn_taking_score_at,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    SpeakerIngestAlignment,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.atomic_json import write_json_atomic
from podcast_mcp.util.progress import resolve_progress_task

log = logging.getLogger(__name__)

DURATION_EPS_SEC = 0.05  # same_length only when durations match within probe noise
MIN_BLEED_MATCHES = 2
BLEED_AGREE_SEC = 0.75
BLEED_IDENTITY_SEC = 1.0  # |bleed| below this → acoustic confirm (not blind identity)
ACOUSTIC_MIN_PEAK = 0.05
ACOUSTIC_FLOOR_SEC = 0.05  # |lag| below this → treat as synced
ACOUSTIC_AGREE_SEC = 0.25  # |acoustic - bleed| must agree when both present
ACOUSTIC_WINDOW_SEC = 8.0
ACOUSTIC_MIN_WINDOW_SEC = 2.0
ACOUSTIC_MAX_LAG_SEC = 1.0
NGRAM_N = 3
MIN_OWN_SPEECH_ISLANDS = 3
CLEARLY_BETTER_SCORE_MARGIN = 2.0
WEAK_OFFSET_CAP_SEC = 2.0
MAX_WORD_AUDIBILITY_SEC = 2.0  # drop Whisper silence hallucinations from occupancy
UTTERANCE_MERGE_GAP_SEC = 2.5  # merge close islands into one first utterance
LATE_JOIN_SILENCE_PAD_SEC = 0.3
LATE_JOIN_MIN_LEAD_SEC = 2.0  # first island must start after leading file silence
SILENCE_REFINE_WINDOW_SEC = 2.0
SILENCE_REFINE_STEP_SEC = 0.05
SILENCE_REFINE_MAX_DRIFT_SEC = 0.3  # keep candidate when silence-mid wanders farther


def resolve_align_bound_sec(
    configured: float | None,
    *,
    durations: list[float],
    fallback: float = 120.0,
) -> float:
    """Search bound: ``<=0`` or None → longest dialogue duration."""
    if configured is not None and float(configured) > 0:
        return float(configured)
    positive = [float(d) for d in durations if d is not None and float(d) > 0]
    return max(positive) if positive else fallback


@dataclass
class GapScore:
    offset_sec: float
    overlap_sec: float
    overlap_at_zero_sec: float
    method: str
    score: float = 0.0


@dataclass
class ClipAlignPlan:
    track_id: str
    clip_id: str
    offset_sec: float
    method: str
    detail: str | None = None
    gap_offset_sec: float | None = None
    bleed_offset_sec: float | None = None
    same_length_prior: bool = False


@dataclass
class AlignResult:
    plans: list[ClipAlignPlan] = field(default_factory=list)
    reference_track_id: str | None = None
    skipped_reason: str | None = None

    def summary(self) -> str:
        if self.skipped_reason:
            return self.skipped_reason
        moved = [p for p in self.plans if abs(p.offset_sec) > 1e-3]
        if not moved:
            return f"{len(self.plans)} clips; all near identity (ref={self.reference_track_id})"
        parts = [f"{p.track_id}:{p.offset_sec:+.2f}s/{p.method}" for p in moved[:6]]
        extra = "" if len(moved) <= 6 else f" +{len(moved) - 6} more"
        return f"{len(moved)} moved ({', '.join(parts)}{extra}); ref={self.reference_track_id}"


def _norm_token(text: str) -> str:
    return re.sub(r"[^\w']+", "", text.lower())


def words_to_tokens(words: list[TranscriptWord]) -> list[WordToken]:
    out: list[WordToken] = []
    for w in words:
        if getattr(w, "suppressed", False):
            continue
        conf = w.confidence if w.confidence is not None else 1.0
        if w.end <= w.start:
            continue
        out.append(WordToken(text=w.text, start=w.start, end=w.end, confidence=float(conf)))
    return out


def transcript_for_clip(
    project: EpisodeProject,
    track_id: str,
    source_id: str | None,
) -> list[WordToken]:
    """Prefer transcript matching source_id; else track-level transcript."""
    matches: list[Transcript] = []
    fallback: list[Transcript] = []
    for tr in project.transcripts:
        if tr.track_id != track_id:
            continue
        sid = getattr(tr, "source_id", None)
        if source_id and sid == source_id:
            matches.append(tr)
        elif sid is None:
            fallback.append(tr)
    chosen = matches[0] if matches else (fallback[0] if fallback else None)
    if chosen is None:
        return []
    return words_to_tokens(list(chosen.words or []))


def own_speech_tokens(
    tokens: list[WordToken],
    peers: list[list[WordToken]],
    *,
    n: int = NGRAM_N,
    min_confidence: float = 0.5,
) -> list[WordToken]:
    """Drop tokens that belong to n-grams shared with a peer (bleed copies)."""
    peer_ngrams: set[str] = set()
    for peer in peers:
        parts = [_norm_token(w.text) for w in peer if w.confidence >= min_confidence]
        parts = [p for p in parts if p]
        for i in range(len(parts) - n + 1):
            peer_ngrams.add(" ".join(parts[i : i + n]))

    if not peer_ngrams:
        return [w for w in tokens if w.confidence >= min_confidence]

    keep = [False] * len(tokens)
    parts = [_norm_token(w.text) for w in tokens]
    conf_ok = [w.confidence >= min_confidence for w in tokens]
    for i, _w in enumerate(tokens):
        if not conf_ok[i] or not parts[i]:
            continue
        is_bleed = False
        for start in range(max(0, i - n + 1), i + 1):
            end = start + n
            if end > len(parts):
                continue
            if not all(conf_ok[j] and parts[j] for j in range(start, end)):
                continue
            gram = " ".join(parts[start:end])
            if gram in peer_ngrams:
                is_bleed = True
                break
        if not is_bleed:
            keep[i] = True
    return [w for i, w in enumerate(tokens) if keep[i]]


def bleed_phrase_offsets(
    reference: list[WordToken],
    source: list[WordToken],
    *,
    n: int = NGRAM_N,
    min_confidence: float = 0.5,
    agree_sec: float = BLEED_AGREE_SEC,
    min_matches: int = MIN_BLEED_MATCHES,
) -> tuple[float | None, list[float], str | None]:
    """Return (median_offset, clustered_offsets, detail) when bleed n-grams agree.

    Offset is ``ref_start - src_start`` so positive means the source file's t=0
    plays later on the session clock.

    Pairing: unique (one hit) n-grams form a provisional median; each ref match
    then picks the source hit nearest that median (not always ``hits[0]``).
    """
    ref_parts = [
        (_norm_token(w.text), w.start, w.end)
        for w in reference
        if w.confidence >= min_confidence and _norm_token(w.text)
    ]
    src_parts = [
        (_norm_token(w.text), w.start, w.end)
        for w in source
        if w.confidence >= min_confidence and _norm_token(w.text)
    ]
    if len(ref_parts) < n or len(src_parts) < n:
        return None, [], None

    src_index: dict[str, list[tuple[float, float]]] = {}
    for i in range(len(src_parts) - n + 1):
        gram = " ".join(p[0] for p in src_parts[i : i + n])
        src_index.setdefault(gram, []).append((src_parts[i][1], src_parts[i + n - 1][2]))

    matches: list[tuple[str, float, list[tuple[float, float]]]] = []
    for i in range(len(ref_parts) - n + 1):
        gram = " ".join(p[0] for p in ref_parts[i : i + n])
        hits = src_index.get(gram)
        if not hits:
            continue
        matches.append((gram, ref_parts[i][1], hits))

    if len(matches) < min_matches:
        return None, [], None

    provisional: list[float] = []
    for _gram, ref_start, hits in matches:
        if len(hits) == 1:
            provisional.append(ref_start - hits[0][0])
    seed = float(statistics.median(provisional)) if provisional else 0.0

    deltas: list[float] = []
    samples: list[str] = []
    for gram, ref_start, hits in matches:
        best_hit = min(hits, key=lambda h: abs((ref_start - h[0]) - seed))
        delta = ref_start - best_hit[0]
        deltas.append(delta)
        if len(samples) < 5:
            samples.append(f"'{gram}' Δ={delta:+.2f}s")

    if len(deltas) < min_matches:
        return None, deltas, None

    med = float(statistics.median(deltas))
    clustered = [d for d in deltas if abs(d - med) <= agree_sec]
    if len(clustered) < min_matches:
        return None, deltas, None
    med = float(statistics.median(clustered))
    detail = f"{len(clustered)}/{len(deltas)} bleed n-grams; " + "; ".join(samples)
    return med, clustered, detail


def _turn_taking_at(
    reference: list[tuple[float, float]],
    source: list[tuple[float, float]],
    offset_sec: float,
) -> tuple[float, float]:
    return turn_taking_score_at(reference, source, offset_sec)


def _turn_taking_score_at(
    reference: list[tuple[float, float]],
    source: list[tuple[float, float]],
    offset_sec: float,
) -> float:
    return _turn_taking_at(reference, source, offset_sec)[0]


def gap_offset_coarse_fine(
    reference: list[tuple[float, float]],
    source: list[tuple[float, float]],
    *,
    max_offset_sec: float = 120.0,
    coarse_step: float = 0.5,
    fine_step: float = 0.02,
    fine_window: float = 1.0,
    prior_offset: float = 0.0,
    require_clear_over_prior: bool = False,
    cancel_check: Callable[[], bool] | None = None,
) -> GapScore:
    if not reference or not source:
        return GapScore(0.0, 0.0, 0.0, method="gaps_empty")

    coarse = offset_turn_taking_score(
        reference,
        source,
        max_offset_sec=max_offset_sec,
        step_sec=coarse_step,
        cancel_check=cancel_check,
    )
    center = coarse.offset_sec
    lo = max(-max_offset_sec, center - fine_window)
    hi = min(max_offset_sec, center + fine_window)
    best_offset = center
    best_score = float("-inf")
    best_overlap = coarse.overlap_sec
    at_zero = coarse.overlap_at_zero_sec
    n_steps = max(0, round((hi - lo) / fine_step))
    for i in range(n_steps + 1):
        raise_if_cancelled(cancel_check)
        offset = lo + i * fine_step
        score, both = _turn_taking_at(reference, source, offset)
        if score > best_score:
            best_score = score
            best_offset = offset
            best_overlap = both

    score_at_prior, overlap_at_prior = _turn_taking_at(reference, source, prior_offset)
    if require_clear_over_prior and best_score < score_at_prior + CLEARLY_BETTER_SCORE_MARGIN:
        log.debug(
            "gap_offset prior win offset=%.3f score=%.2f (coarse=%.3f refined=%.3f)",
            prior_offset,
            score_at_prior,
            center,
            best_offset,
        )
        return GapScore(
            offset_sec=prior_offset,
            overlap_sec=overlap_at_prior,
            overlap_at_zero_sec=at_zero,
            method="gaps_prior",
            score=score_at_prior,
        )

    log.debug(
        "gap_offset coarse=%.3f refined=%.3f score=%.2f max_offset=%.3f",
        center,
        best_offset,
        best_score,
        max_offset_sec,
    )
    return GapScore(
        offset_sec=best_offset,
        overlap_sec=best_overlap,
        overlap_at_zero_sec=at_zero,
        method="gaps",
        score=best_score,
    )


def union_intervals(groups: list[list[tuple[float, float]]]) -> list[tuple[float, float]]:
    return merge_timeline_ranges([iv for g in groups for iv in g])


def durations_match(
    a: float | None,
    b: float | None,
    *,
    eps: float = DURATION_EPS_SEC,
) -> bool:
    """True when file lengths match within probe noise (near-exact)."""
    if a is None or b is None:
        return False
    return abs(float(a) - float(b)) <= eps


def pick_reference_track(tracks: list[Track]) -> Track:
    for t in tracks:
        label = (t.label or "").lower()
        speaker = (t.speaker or "").lower()
        if label == "host" or speaker == "host":
            return t
    with_dur = [(t, float(t.media.duration_sec or 0.0) if t.media else 0.0) for t in tracks]
    with_dur.sort(key=lambda x: x[1], reverse=True)
    return with_dur[0][0]


def dialogue_align_units(
    project: EpisodeProject,
) -> list[tuple[Track, Clip, list[WordToken], float]]:
    """(track, clip, tokens, duration) for each dialogue clip that has media."""
    units: list[tuple[Track, Clip, list[WordToken], float]] = []
    for track in project.tracks:
        if track.role != TrackRole.DIALOGUE:
            continue
        clips = [c for c in project.clips if c.track_id == track.id]
        if not clips and track.media:
            dur = float(track.media.duration_sec or 0.0)
            clips = [
                Clip(
                    id=f"clip_{track.id}",
                    track_id=track.id,
                    source_start=0.0,
                    source_end=dur,
                    timeline_start=0.0,
                )
            ]
        for clip in clips:
            tokens = transcript_for_clip(project, track.id, clip.source_id)
            file_dur: float | None = None
            if clip.source_id:
                src = next((s for s in project.sources if s.id == clip.source_id), None)
                if src and src.duration_sec is not None:
                    file_dur = float(src.duration_sec)
            if file_dur is None and track.media and track.media.duration_sec is not None:
                file_dur = float(track.media.duration_sec)
            if file_dur is None:
                file_dur = float(clip.source_end - clip.source_start)
            units.append((track, clip, tokens, file_dur))
    return units


@dataclass
class AcousticOffset:
    """Clip-geometry signed lag: negative advances source (trim), positive delays it."""

    offset_sec: float
    peak: float
    n_windows: int
    detail: str


def resolve_clip_wav(project: EpisodeProject, track: Track, clip: Clip) -> Path | None:
    """Resolve on-disk WAV for a dialogue clip (primary media or sources[] row)."""
    try:
        path = resolve_clip_audio_path(project, track, clip)
    except (ValueError, FileNotFoundError, OSError):
        return None
    return path if path.is_file() else None


def _probe_duration_sec(path: Path) -> float | None:
    try:
        from podcast_mcp.engines.ffmpeg import FFmpegEngine

        return float(FFmpegEngine().probe(path).duration_sec)
    except (OSError, ValueError, subprocess.CalledProcessError):
        return None


def _acoustic_window_and_starts(
    duration_sec: float | None,
    *,
    window_sec: float,
    max_lag_sec: float,
    starts: list[float] | None,
) -> tuple[float, list[float]]:
    """Fit xcorr window and start times to file duration. ``window_sec`` is a cap."""
    if starts is not None:
        win = window_sec
        if duration_sec is not None and duration_sec > 0:
            win = min(window_sec, max(0.1, duration_sec))
        return win, list(starts)
    if duration_sec is None or duration_sec <= 0:
        return window_sec, [float(s) for s in range(15, 400, 10)]
    win = min(window_sec, max(ACOUSTIC_MIN_WINDOW_SEC, duration_sec - max_lag_sec))
    win = min(max(0.1, win), duration_sec)
    last = max(0.0, duration_sec - win)
    out = [0.0]
    mid = last / 2.0
    if mid > 0.05:
        out.append(mid)
    t = 15.0
    while t <= last + 1e-9:
        out.append(t)
        t += 10.0
    uniq = sorted({round(s, 3) for s in out if 0.0 <= s <= last + 1e-9})
    return win, uniq


def acoustic_clip_offset(
    reference: Path,
    source: Path,
    *,
    max_lag_sec: float = ACOUSTIC_MAX_LAG_SEC,
    window_sec: float = ACOUSTIC_WINDOW_SEC,
    starts: list[float] | None = None,
    source_starts: list[float] | None = None,
    min_peak: float = ACOUSTIC_MIN_PEAK,
    sample_rate: int = 8000,
    min_rms: float = 0.01,
    cancel_check: Callable[[], bool] | None = None,
) -> AcousticOffset | None:
    """Median multi-window lag in clip-geometry sign (not estimate_offset_sec's mix delay).

    Uses ``-estimate_offset_sec(ref, source)`` so positive delays the source clip and
    negative advances it (``source_start`` trim) — matching ``offset_to_clip_geometry``.
    """
    import numpy as np

    from podcast_mcp.engines.align import estimate_offset_from_arrays, load_mono_window

    if starts is not None and source_starts is not None and len(source_starts) != len(starts):
        raise ValueError("source_starts must match starts")
    ref_dur = _probe_duration_sec(reference)
    src_dur = _probe_duration_sec(source)
    fit_dur = None
    if ref_dur is not None and src_dur is not None:
        fit_dur = min(ref_dur, src_dur)
    elif ref_dur is not None:
        fit_dur = ref_dur
    elif src_dur is not None:
        fit_dur = src_dur
    window_sec, ref_starts = _acoustic_window_and_starts(
        fit_dur,
        window_sec=window_sec,
        max_lag_sec=max_lag_sec,
        starts=starts,
    )
    if source_starts is None:
        source_starts = list(ref_starts)
    pairs: list[tuple[float, float]] = []
    for ref_start, src_start in zip(ref_starts, source_starts, strict=True):
        if ref_start < 0 or src_start < 0:
            continue
        if ref_dur is not None and ref_start > max(0.0, ref_dur - window_sec):
            continue
        if src_dur is not None and src_start > max(0.0, src_dur - window_sec):
            continue
        pairs.append((ref_start, src_start))

    offsets: list[float] = []
    peaks: list[float] = []
    n_tried = 0
    n_decode_error = 0
    for ref_start, src_start in pairs:
        raise_if_cancelled(cancel_check)
        n_tried += 1
        try:
            ref = load_mono_window(
                reference,
                start_sec=ref_start,
                duration_sec=window_sec,
                sample_rate=sample_rate,
            )
            src = load_mono_window(
                source,
                start_sec=src_start,
                duration_sec=window_sec,
                sample_rate=sample_rate,
            )
        except (OSError, ValueError, subprocess.CalledProcessError):
            n_decode_error += 1
            continue
        if float(np.sqrt(np.mean(ref**2))) < min_rms or float(np.sqrt(np.mean(src**2))) < min_rms:
            continue
        try:
            result = estimate_offset_from_arrays(
                ref,
                src,
                max_lag_sec=max_lag_sec,
                sample_rate=sample_rate,
                reference=reference,
                source=source,
            )
        except (OSError, ValueError, subprocess.CalledProcessError):
            n_decode_error += 1
            continue
        if result.correlation_peak < min_peak:
            continue
        offsets.append(-float(result.offset_sec))
        peaks.append(float(result.correlation_peak))
        if len(offsets) >= 5:
            med = float(statistics.median(offsets))
            if all(abs(o - med) <= ACOUSTIC_AGREE_SEC for o in offsets[-5:]):
                break

    if not offsets:
        if n_tried > 0 and n_decode_error == n_tried:
            raise RuntimeError(
                f"acoustic confirm failed: could not decode any window ({reference} / {source})"
            )
        return None
    med = float(statistics.median(offsets))
    peak = float(statistics.median(peaks))
    return AcousticOffset(
        offset_sec=med,
        peak=peak,
        n_windows=len(offsets),
        detail=f"acoustic median={med:+.3f}s peak={peak:.3f} n={len(offsets)}",
    )


def _confirm_small_bleed(
    bleed_off: float,
    *,
    bleed_detail: str | None,
    ref_audio: Path | None,
    src_audio: Path | None,
    acoustic_min_peak: float,
    acoustic_floor_sec: float,
    acoustic_agree_sec: float,
    acoustic_fn: Callable[[Path, Path], AcousticOffset | None] | None,
    cancel_check: Callable[[], bool] | None = None,
) -> tuple[str, float, str]:
    """Return (method, offset, detail) for |bleed| below identity threshold."""
    acoustic: AcousticOffset | None = None
    if acoustic_fn is not None:
        # Tests inject a stub; paths may be missing for fixture projects.
        acoustic = acoustic_fn(ref_audio or Path("ref"), src_audio or Path("src"))
    elif ref_audio is not None and src_audio is not None:
        acoustic = acoustic_clip_offset(
            ref_audio,
            src_audio,
            min_peak=acoustic_min_peak,
            cancel_check=cancel_check,
        )

    if acoustic is None:
        return (
            "bleed_near_identity",
            0.0,
            f"bleed |Δt|={abs(bleed_off):.2f}s; no acoustic confirm; held at 0"
            + (f"; {bleed_detail}" if bleed_detail else ""),
        )

    if abs(acoustic.offset_sec) < acoustic_floor_sec:
        return (
            "bleed_near_identity",
            0.0,
            f"bleed |Δt|={abs(bleed_off):.2f}s; {acoustic.detail}; synced; held at 0",
        )

    same_sign = bleed_off == 0.0 or (acoustic.offset_sec * bleed_off) > 0
    agrees = abs(acoustic.offset_sec - bleed_off) <= acoustic_agree_sec
    if same_sign and agrees:
        return (
            "bleed_acoustic",
            acoustic.offset_sec,
            f"{acoustic.detail}; bleed={bleed_off:+.3f}s"
            + (f"; {bleed_detail}" if bleed_detail else ""),
        )

    return (
        "bleed_near_identity",
        0.0,
        f"bleed={bleed_off:+.3f}s disagrees with {acoustic.detail}; held at 0",
    )


def filter_long_tokens(
    tokens: list[WordToken],
    *,
    max_word_sec: float = MAX_WORD_AUDIBILITY_SEC,
) -> list[WordToken]:
    """Drop ASR spans longer than max_word_sec (silence hallucinations)."""
    return [t for t in tokens if (t.end - t.start) <= max_word_sec]


def _own_speech_intervals(
    tokens: list[WordToken],
    peers: list[list[WordToken]],
    *,
    ngram_n: int = NGRAM_N,
    max_word_sec: float = MAX_WORD_AUDIBILITY_SEC,
) -> list[tuple[float, float]]:
    """Own-speech islands after dropping long ASR tokens and peer bleed n-grams."""
    tokens_occ = filter_long_tokens(tokens, max_word_sec=max_word_sec)
    peers_occ = [filter_long_tokens(p, max_word_sec=max_word_sec) for p in peers]
    own = own_speech_tokens(tokens_occ, peers_occ, n=ngram_n)
    return speech_intervals(own)


def _first_utterance_from_intervals(
    intervals: list[tuple[float, float]],
    *,
    max_gap_sec: float = UTTERANCE_MERGE_GAP_SEC,
) -> tuple[float, float] | None:
    """Start/end of the first speech cluster (islands merged while gap <= max_gap_sec)."""
    if not intervals:
        return None
    start = float(intervals[0][0])
    end = float(intervals[0][1])
    for s, e in intervals[1:]:
        if float(s) - end > max_gap_sec:
            break
        end = float(e)
    return start, end


def first_utterance_span(
    tokens: list[WordToken],
    *,
    max_gap_sec: float = UTTERANCE_MERGE_GAP_SEC,
) -> tuple[float, float] | None:
    """Start/end of the first speech cluster (islands merged while gap <= max_gap_sec)."""
    return _first_utterance_from_intervals(
        speech_intervals(tokens),
        max_gap_sec=max_gap_sec,
    )


def first_utterance_end(
    tokens: list[WordToken],
    *,
    max_gap_sec: float = UTTERANCE_MERGE_GAP_SEC,
) -> float | None:
    """End of the first speech cluster (islands merged while gap <= max_gap_sec)."""
    span = first_utterance_span(tokens, max_gap_sec=max_gap_sec)
    return None if span is None else span[1]


def late_join_offset(
    reference: list[tuple[float, float]],
    source: list[tuple[float, float]],
    *,
    max_offset_sec: float,
    utterance_gap_sec: float = UTTERANCE_MERGE_GAP_SEC,
    pad_sec: float = LATE_JOIN_SILENCE_PAD_SEC,
    min_lead_sec: float = LATE_JOIN_MIN_LEAD_SEC,
    fine_step: float = 0.02,
    cancel_check: Callable[[], bool] | None = None,
) -> tuple[float | None, str | None]:
    """Park first real speech in a host silence long enough to hold it.

    Candidate delay = silence midpoint - utterance center (or silence start if
    mid would overhang). Accept only when turn-taking clearly beats identity and
    the offset is inside the bound (not a search wall).
    """
    if not reference or not source:
        return None, None
    utterance = _first_utterance_from_intervals(source, max_gap_sec=utterance_gap_sec)
    if utterance is None:
        return None, None
    u_start, u_end = utterance
    if u_start < min_lead_sec:
        return None, None
    u_dur = u_end - u_start
    u_center = (u_start + u_end) / 2.0
    session_end = max(reference[-1][1], u_end + max_offset_sec) + 30.0
    silences = [
        (s, e)
        for s, e in host_silences(reference, session_end=session_end)
        if (e - s) >= u_dur + pad_sec
    ]
    if not silences:
        return None, None

    score_0 = _turn_taking_score_at(reference, source, 0.0)
    best_off: float | None = None
    best_score = score_0
    best_detail: str | None = None

    for sil_s, sil_e in silences:
        raise_if_cancelled(cancel_check)
        mid = (sil_s + sil_e) / 2.0
        cand = mid - u_center
        placed_s = u_start + cand
        placed_e = u_end + cand
        if placed_s < sil_s - 1e-6 or placed_e > sil_e + 1e-6:
            cand = sil_s + pad_sec - u_start
            placed_s = u_start + cand
            placed_e = u_end + cand
            if placed_e > sil_e + pad_sec + 1e-6:
                continue
        if abs(cand) <= WEAK_OFFSET_CAP_SEC:
            continue
        if abs(cand) > max_offset_sec + 1e-9:
            continue
        if abs(cand) >= max_offset_sec - fine_step:
            continue
        score = _turn_taking_score_at(reference, source, cand)
        sm = silence_midpoint_score(reference, source, cand)
        ranked = score if sm == float("-inf") else score + 0.05 * sm
        if ranked > best_score:
            best_score = ranked
            best_off = cand
            best_detail = (
                f"first utterance [{u_start:.2f},{u_end:.2f}] into "
                f"host silence [{sil_s:.2f},{sil_e:.2f}]"
            )

    if best_off is None:
        return None, None
    pure = _turn_taking_score_at(reference, source, best_off)
    if pure < score_0 + CLEARLY_BETTER_SCORE_MARGIN:
        return None, (
            f"late-join {best_off:+.2f}s not clearly better than identity "
            f"({pure:.1f} vs {score_0:.1f})"
        )
    return best_off, best_detail


def host_silences(
    host_iv: list[tuple[float, float]],
    *,
    session_end: float | None = None,
) -> list[tuple[float, float]]:
    if not host_iv:
        return []
    sil: list[tuple[float, float]] = []
    if host_iv[0][0] > 0.05:
        sil.append((0.0, host_iv[0][0]))
    for (_s0, e0), (s1, _e1) in itertools.pairwise(host_iv):
        if s1 > e0:
            sil.append((e0, s1))
    end = session_end if session_end is not None else host_iv[-1][1] + 30.0
    if end > host_iv[-1][1]:
        sil.append((host_iv[-1][1], end))
    return sil


def silence_midpoint_score(
    reference: list[tuple[float, float]],
    source: list[tuple[float, float]],
    offset_sec: float,
    *,
    max_silence_sec: float = 12.0,
) -> float:
    """Higher when source island centers sit near host-silence midpoints.

    Crosstalk is allowed: centers may land near silence mids even when gaps are
    slightly negative after a coarse place (scored via nearest silence).
    """
    sil = [(s, e) for s, e in host_silences(reference) if 0.15 <= (e - s) <= max_silence_sec]
    if not sil or not source:
        return float("-inf")
    mids = [(s + e) / 2.0 for s, e in sil]
    half = [max((e - s) / 2.0, 0.1) for s, e in sil]
    in_sil = 0
    errs: list[float] = []
    for s, e in source:
        center = (s + e) / 2.0 + offset_sec
        best_i = 0
        best_d = abs(mids[0] - center)
        for i, mid in enumerate(mids[1:], start=1):
            d = abs(mid - center)
            if d < best_d:
                best_d = d
                best_i = i
        sil_s, sil_e = sil[best_i]
        if sil_s <= center <= sil_e:
            in_sil += 1
            errs.append(best_d / half[best_i])
        else:
            outside = min(abs(center - sil_s), abs(center - sil_e))
            errs.append(1.0 + outside)
    errs.sort()
    med = errs[len(errs) // 2]
    return float(in_sil) * 3.0 - med * 8.0 - 0.01 * abs(offset_sec)


def refine_offset_silence_midpoint(
    reference: list[tuple[float, float]],
    source: list[tuple[float, float]],
    center_sec: float,
    *,
    window_sec: float = SILENCE_REFINE_WINDOW_SEC,
    step_sec: float = SILENCE_REFINE_STEP_SEC,
    max_offset_sec: float | None = None,
    max_drift_sec: float | None = SILENCE_REFINE_MAX_DRIFT_SEC,
    cancel_check: Callable[[], bool] | None = None,
) -> tuple[float, str | None]:
    """Local ±window refine maximizing silence-midpoint fit (crosstalk-tolerant).

    When ``max_drift_sec`` is set, discard a refine that wanders farther from
    ``center_sec`` (keeps late-join candidates within a few hundred ms).
    """
    if not reference or not source:
        return center_sec, None
    lo = center_sec - window_sec
    hi = center_sec + window_sec
    if max_offset_sec is not None:
        lo = max(-max_offset_sec, lo)
        hi = min(max_offset_sec, hi)
    best = center_sec
    best_score = silence_midpoint_score(reference, source, center_sec)
    n = max(0, round((hi - lo) / step_sec))
    for i in range(n + 1):
        raise_if_cancelled(cancel_check)
        off = lo + i * step_sec
        score = silence_midpoint_score(reference, source, off)
        if score > best_score:
            best_score = score
            best = off
    if abs(best - center_sec) < step_sec / 2:
        return center_sec, None
    if max_drift_sec is not None and abs(best - center_sec) > max_drift_sec:
        return center_sec, None
    return best, f"silence-mid refine {center_sec:+.2f}→{best:+.2f}s"


def offset_to_clip_geometry(
    offset_sec: float,
    *,
    media_duration: float,
) -> tuple[float, float, float]:
    """Return (source_start, source_end, timeline_start) for a whole-file clip."""
    if offset_sec >= 0:
        return 0.0, media_duration, offset_sec
    lead = -offset_sec
    if lead >= media_duration:
        lead = max(0.0, media_duration - 0.01)
    return lead, media_duration, 0.0


def _with_silence_refine(
    union: list[tuple[float, float]],
    own_iv: list[tuple[float, float]],
    offset: float,
    detail: str,
    *,
    max_offset: float,
    cancel_check: Callable[[], bool] | None = None,
) -> tuple[float, str]:
    refined, refine_detail = refine_offset_silence_midpoint(
        union,
        own_iv,
        offset,
        max_offset_sec=max_offset,
        cancel_check=cancel_check,
    )
    if refine_detail:
        detail = f"{detail}; {refine_detail}"
    return refined, detail


def _gap_is_confident(
    gap: GapScore,
    *,
    max_offset: float,
    fine_step: float,
    n_islands: int,
) -> tuple[bool, str]:
    """Whether gap occupancy is trustworthy enough for the applied offset."""
    if gap.method in {"gaps_empty", "gaps_prior"}:
        return abs(gap.offset_sec) <= WEAK_OFFSET_CAP_SEC, gap.method
    if abs(gap.offset_sec) >= max_offset - fine_step:
        return False, "wall"
    if n_islands < MIN_OWN_SPEECH_ISLANDS and abs(gap.offset_sec) > WEAK_OFFSET_CAP_SEC:
        return False, "weak_islands"
    return True, "ok"


def _score_one_clip(
    *,
    tokens: list[WordToken],
    peers_tokens: list[list[WordToken]],
    union: list[tuple[float, float]],
    same_len: bool,
    ngram_n: int,
    min_bleed: int,
    max_offset: float,
    coarse_step: float,
    fine_step: float,
    bleed_identity_sec: float = BLEED_IDENTITY_SEC,
    ref_audio: Path | None = None,
    src_audio: Path | None = None,
    acoustic_min_peak: float = ACOUSTIC_MIN_PEAK,
    acoustic_floor_sec: float = ACOUSTIC_FLOOR_SEC,
    acoustic_agree_sec: float = ACOUSTIC_AGREE_SEC,
    acoustic_fn: Callable[[Path, Path], AcousticOffset | None] | None = None,
    max_word_sec: float = MAX_WORD_AUDIBILITY_SEC,
    prev_plan: ClipAlignPlan | None = None,
    cancel_check: Callable[[], bool] | None = None,
    bleed_ref_tokens: list[WordToken] | None = None,
) -> ClipAlignPlan:
    own_iv = _own_speech_intervals(
        tokens,
        peers_tokens,
        ngram_n=ngram_n,
        max_word_sec=max_word_sec,
    )

    bleed_ref = list(bleed_ref_tokens) if bleed_ref_tokens is not None else []
    if not bleed_ref:
        for pt in peers_tokens:
            bleed_ref.extend(pt)
    bleed_off, _bleed_all, bleed_detail = bleed_phrase_offsets(
        bleed_ref,
        tokens,
        n=ngram_n,
        min_matches=min_bleed,
    )

    def _plan(
        *,
        method: str,
        offset: float,
        detail: str,
        gap_offset: float | None = None,
    ) -> ClipAlignPlan:
        return ClipAlignPlan(
            track_id="",
            clip_id="",
            offset_sec=offset,
            method=method,
            detail=detail,
            gap_offset_sec=gap_offset,
            bleed_offset_sec=bleed_off,
            same_length_prior=same_len,
        )

    if bleed_off is not None and abs(bleed_off) < bleed_identity_sec:
        if (
            prev_plan is not None
            and prev_plan.bleed_offset_sec is not None
            and abs(prev_plan.bleed_offset_sec - bleed_off) < 1e-9
            and prev_plan.method.startswith("bleed")
        ):
            return _plan(
                method=prev_plan.method,
                offset=prev_plan.offset_sec,
                detail=prev_plan.detail or "reused pass-1 bleed",
            )
        method, offset, detail = _confirm_small_bleed(
            bleed_off,
            bleed_detail=bleed_detail,
            ref_audio=ref_audio,
            src_audio=src_audio,
            acoustic_min_peak=acoustic_min_peak,
            acoustic_floor_sec=acoustic_floor_sec,
            acoustic_agree_sec=acoustic_agree_sec,
            acoustic_fn=acoustic_fn,
            cancel_check=cancel_check,
        )
        return _plan(method=method, offset=offset, detail=detail)
    if bleed_off is not None:
        return _plan(method="bleed", offset=bleed_off, detail=bleed_detail or "bleed")

    gap = gap_offset_coarse_fine(
        union,
        own_iv,
        max_offset_sec=max_offset,
        coarse_step=coarse_step,
        fine_step=fine_step,
        prior_offset=0.0,
        require_clear_over_prior=same_len,
        cancel_check=cancel_check,
    )
    confident, why = _gap_is_confident(
        gap,
        max_offset=max_offset,
        fine_step=fine_step,
        n_islands=len(own_iv),
    )
    gap_wants_move = confident and abs(gap.offset_sec) > WEAK_OFFSET_CAP_SEC

    if gap_wants_move:
        offset, detail = _with_silence_refine(
            union,
            own_iv,
            gap.offset_sec,
            f"gap score; islands={len(own_iv)}",
            max_offset=max_offset,
            cancel_check=cancel_check,
        )
        log.debug(
            "clip gaps move offset=%.3f (gap=%.3f why=%s); late-join skipped",
            offset,
            gap.offset_sec,
            why,
        )
        return _plan(method="gaps", offset=offset, detail=detail, gap_offset=gap.offset_sec)

    late_off, late_detail = late_join_offset(
        union,
        own_iv,
        max_offset_sec=max_offset,
        fine_step=fine_step,
        cancel_check=cancel_check,
    )
    if late_off is not None:
        offset, detail = _with_silence_refine(
            union,
            own_iv,
            late_off,
            late_detail or "late-join occupancy",
            max_offset=max_offset,
            cancel_check=cancel_check,
        )
        return _plan(
            method="gaps_late",
            offset=offset,
            detail=detail,
            gap_offset=gap.offset_sec,
        )

    if confident:
        return _plan(
            method="gaps",
            offset=gap.offset_sec,
            detail=f"gap score; islands={len(own_iv)}",
            gap_offset=gap.offset_sec,
        )
    if same_len and abs(gap.offset_sec) >= WEAK_OFFSET_CAP_SEC:
        return _plan(
            method="same_length",
            offset=0.0,
            detail="equal duration prior (gaps not confident)",
            gap_offset=gap.offset_sec,
        )
    detail = f"gap not confident ({why}; {gap.offset_sec:+.2f}s); held at 0"
    if late_detail:
        detail = f"{detail}; {late_detail}"
    return _plan(method="weak_hold", offset=0.0, detail=detail, gap_offset=gap.offset_sec)


def plan_conversation_alignment(
    project: EpisodeProject,
    *,
    defaults: dict[str, Any] | None = None,
) -> AlignResult:
    cfg = (defaults or {}).get("align") or {}
    coarse_step = float(cfg.get("coarse_step_sec", 0.5))
    fine_step = float(cfg.get("fine_step_sec", 0.02))
    ngram_n = int(cfg.get("bleed_ngram", NGRAM_N))
    min_bleed = int(cfg.get("min_bleed_matches", MIN_BLEED_MATCHES))
    bleed_identity_sec = float(cfg.get("bleed_identity_sec", BLEED_IDENTITY_SEC))
    acoustic_min_peak = float(cfg.get("acoustic_min_peak", ACOUSTIC_MIN_PEAK))
    acoustic_floor_sec = float(cfg.get("acoustic_floor_sec", ACOUSTIC_FLOOR_SEC))
    acoustic_agree_sec = float(cfg.get("acoustic_agree_sec", ACOUSTIC_AGREE_SEC))
    max_word_sec = float(cfg.get("max_word_audibility_sec", MAX_WORD_AUDIBILITY_SEC))
    acoustic_fn = (defaults or {}).get("_align_acoustic_fn")
    cancel_check = (defaults or {}).get("_pipeline_cancel_check")
    if cancel_check is not None and not callable(cancel_check):
        cancel_check = None

    units = dialogue_align_units(project)
    if len(units) < 2:
        return AlignResult(skipped_reason="skipped (<2 dialogue clips)")

    clip_total = max(1, len(units) * 2)

    all_durs = [d for _t, _c, _tok, d in units]
    max_offset = resolve_align_bound_sec(
        cfg.get("max_offset_sec"),
        durations=all_durs,
    )
    tracks: list[Track] = []
    seen: set[str] = set()
    for track, _clip, _tok, _dur in units:
        if track.id not in seen:
            tracks.append(track)
            seen.add(track.id)
    ref_track = pick_reference_track(tracks)
    ref_clip = next((c for t, c, _tok, _d in units if t.id == ref_track.id), None)
    ref_audio = resolve_clip_wav(project, ref_track, ref_clip) if ref_clip is not None else None

    offsets: dict[tuple[str, str], ClipAlignPlan] = {}
    for track, clip, _tokens, _dur in units:
        if track.id == ref_track.id:
            offsets[(track.id, clip.id)] = ClipAlignPlan(
                track_id=track.id,
                clip_id=clip.id,
                offset_sec=0.0,
                method="reference",
                detail="reference track",
            )

    ref_durs = [d for t, _c, _tok, d in units if t.id == ref_track.id]
    ref_tokens: list[WordToken] = []
    for t, _c, tok, _d in units:
        if t.id == ref_track.id:
            ref_tokens.extend(tok)

    def rebuild_placed() -> dict[tuple[str, str], list[tuple[float, float]]]:
        placed: dict[tuple[str, str], list[tuple[float, float]]] = {}
        for track, clip, tokens, _dur in units:
            plan = offsets.get((track.id, clip.id))
            if plan is None:
                continue
            peers = [tok for t, _c, tok, _d in units if t.id != track.id]
            own_iv = _own_speech_intervals(
                tokens,
                peers,
                ngram_n=ngram_n,
                max_word_sec=max_word_sec,
            )
            off = plan.offset_sec
            placed[(track.id, clip.id)] = [(s + off, e + off) for s, e in own_iv]
        return placed

    with resolve_progress_task(
        "align_tracks",
        "Aligning conversation",
        total=clip_total,
        prefer_parent=True,
    ) as prog:
        prog.set_phase("search_bleed", "Scoring bleed windows…")
        for pass_i in range(2):
            placed_iv = rebuild_placed()
            for track, clip, tokens, dur in units:
                if track.id == ref_track.id:
                    prog.advance(1, message=f"Pass {pass_i + 1}: reference {clip.id}")
                    continue
                raise_if_cancelled(cancel_check)
                peer_ivs = [iv for (tid, _cid), iv in placed_iv.items() if tid != track.id]
                union = union_intervals(peer_ivs)
                same_len = any(durations_match(dur, rd) for rd in ref_durs)
                # Peers = other tracks only (never self — self n-grams force Δ=0).
                peers = [tok for t, _c, tok, _d in units if t.id != track.id]
                src_audio = resolve_clip_wav(project, track, clip)
                scored = _score_one_clip(
                    tokens=tokens,
                    peers_tokens=peers,
                    union=union,
                    same_len=same_len,
                    ngram_n=ngram_n,
                    min_bleed=min_bleed,
                    max_offset=max_offset,
                    coarse_step=coarse_step,
                    fine_step=fine_step,
                    bleed_identity_sec=bleed_identity_sec,
                    ref_audio=ref_audio,
                    src_audio=src_audio,
                    acoustic_min_peak=acoustic_min_peak,
                    acoustic_floor_sec=acoustic_floor_sec,
                    acoustic_agree_sec=acoustic_agree_sec,
                    acoustic_fn=acoustic_fn,
                    max_word_sec=max_word_sec,
                    prev_plan=offsets.get((track.id, clip.id)),
                    cancel_check=cancel_check,
                    bleed_ref_tokens=ref_tokens,
                )
                scored.track_id = track.id
                scored.clip_id = clip.id
                offsets[(track.id, clip.id)] = scored
                # Mid-pass: later tracks see this placement in the peer union.
                own_iv = _own_speech_intervals(
                    tokens,
                    peers,
                    ngram_n=ngram_n,
                    max_word_sec=max_word_sec,
                )
                placed_iv[(track.id, clip.id)] = [
                    (s + scored.offset_sec, e + scored.offset_sec) for s, e in own_iv
                ]
                prog.advance(1, message=f"Pass {pass_i + 1}: clip {clip.id}")
    plans = list(offsets.values())
    # Stable order: reference first, then by track/clip
    plans.sort(key=lambda p: (0 if p.method == "reference" else 1, p.track_id, p.clip_id))
    return AlignResult(plans=plans, reference_track_id=ref_track.id)


def apply_alignment_plans(project: EpisodeProject, result: AlignResult) -> int:
    """Mutate clips + meta.ingest_alignment. Returns number of clips updated."""
    if result.skipped_reason or not result.plans:
        return 0
    by_key = {(p.track_id, p.clip_id): p for p in result.plans}
    updated = 0
    align_meta: dict[str, SpeakerIngestAlignment] = dict(project.meta.ingest_alignment or {})
    clips_by_track: dict[str, int] = {}
    for track in project.tracks:
        if track.role != TrackRole.DIALOGUE:
            continue
        clips_by_track[track.id] = len([c for c in project.clips if c.track_id == track.id])

    for track in project.tracks:
        if track.role != TrackRole.DIALOGUE:
            continue
        clips = [c for c in project.clips if c.track_id == track.id]
        if not clips and track.media:
            dur = float(track.media.duration_sec or 0.0)
            clip = Clip(
                id=f"clip_{track.id}",
                track_id=track.id,
                source_start=0.0,
                source_end=dur,
                timeline_start=0.0,
            )
            project.clips.append(clip)
            clips = [clip]
        for clip in clips:
            plan = by_key.get((track.id, clip.id))
            if plan is None:
                continue
            media_dur = float(clip.source_end) if clip.source_end > clip.source_start else 0.0
            if track.media and track.media.duration_sec:
                media_dur = float(track.media.duration_sec)
            if clip.source_id:
                src = next((s for s in project.sources if s.id == clip.source_id), None)
                if src and src.duration_sec:
                    media_dur = float(src.duration_sec)
            src_start, src_end, tl_start = offset_to_clip_geometry(
                plan.offset_sec,
                media_duration=media_dur,
            )
            if abs(plan.offset_sec) < 1e-9:
                # Identity: keep ingest placement (sequential extra clips stay put).
                src_start = clip.source_start
                src_end = clip.source_end
                tl_start = clip.timeline_start
            clip.source_start = src_start
            clip.source_end = src_end
            clip.timeline_start = tl_start
            updated += 1
            session_start = src_start if tl_start <= 0 else 0.0
            content = tl_start if tl_start > 0 else 0.0
            speaker = track.speaker or track.label or track.id
            key = f"{track.id}:{clip.id}" if clips_by_track.get(track.id, 1) > 1 else speaker
            align_meta[key] = SpeakerIngestAlignment(
                session_start_in_file_sec=session_start,
                content_align_sec=content,
                align_method=plan.method,
            )

    project.meta.ingest_alignment = align_meta or None
    refresh_timeline_duration(project)
    return updated


def write_alignment_artifact(project: EpisodeProject, result: AlignResult) -> Path:
    out_dir = project.artifacts_dir() / "alignment"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "conversation_align.json"
    payload = {
        "reference_track_id": result.reference_track_id,
        "skipped_reason": result.skipped_reason,
        "plans": [
            {
                "track_id": p.track_id,
                "clip_id": p.clip_id,
                "offset_sec": p.offset_sec,
                "method": p.method,
                "detail": p.detail,
                "gap_offset_sec": p.gap_offset_sec,
                "bleed_offset_sec": p.bleed_offset_sec,
                "same_length_prior": p.same_length_prior,
            }
            for p in result.plans
        ],
    }
    write_json_atomic(path, payload)
    return path


def snapshot_clip_geometry(project: EpisodeProject) -> list[tuple[str, float, float, float]]:
    return [(c.id, c.source_start, c.source_end, c.timeline_start) for c in project.clips]


def restore_clip_geometry(
    project: EpisodeProject,
    snap: list[tuple[str, float, float, float]],
) -> None:
    by_id = {c.id: c for c in project.clips}
    for cid, source_start, source_end, timeline_start in snap:
        clip = by_id.get(cid)
        if clip is None:
            continue
        clip.source_start = source_start
        clip.source_end = source_end
        clip.timeline_start = timeline_start


def run_conversation_align(
    project: EpisodeProject,
    *,
    defaults: dict[str, Any] | None = None,
) -> AlignResult:
    result = plan_conversation_alignment(project, defaults=defaults)
    if result.skipped_reason:
        write_alignment_artifact(project, result)
        return result
    snap = snapshot_clip_geometry(project)
    try:
        apply_alignment_plans(project, result)
        write_alignment_artifact(project, result)
    except Exception:
        restore_clip_geometry(project, snap)
        artifact = project.artifacts_dir() / "alignment" / "conversation_align.json"
        artifact.unlink(missing_ok=True)
        raise
    return result


def alignment_fingerprint(project: EpisodeProject) -> str:
    parts: list[str] = []
    for clip in sorted(project.clips, key=lambda c: (c.track_id, c.id)):
        parts.append(
            f"{clip.track_id}:{clip.id}:{clip.source_start:.4f}:"
            f"{clip.source_end:.4f}:{clip.timeline_start:.4f}"
        )
    meta = project.meta.ingest_alignment or {}
    for key in sorted(meta.keys()):
        a = meta[key]
        parts.append(
            f"{key}:{a.session_start_in_file_sec:.4f}:{a.content_align_sec:.4f}:{a.align_method}"
        )
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]
