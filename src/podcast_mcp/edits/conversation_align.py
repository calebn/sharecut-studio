"""Places dialogue clips on one session timeline.

A whole-file clip is re-placed from the file offset; a split, trimmed or rippled
track keeps every timeline edit point and slips its source by the offset delta.
Never blades or splits media.
"""

from __future__ import annotations

import collections
import hashlib
import itertools
import logging
import statistics
import subprocess
from bisect import bisect_left
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.ranges import merge_timeline_ranges
from podcast_mcp.edits.track_media import refresh_timeline_duration
from podcast_mcp.engines.play_audit import probe_wav_duration_sec
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    clip_media_key,
    clip_source_to_timeline_shift,
    same_source_timeline_overlaps,
    slip_clip_to_shift,
)
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
from podcast_mcp.util.wer import normalize_token

log = logging.getLogger(__name__)

DURATION_EPS_SEC = 0.05  # same_length only when durations match within probe noise
MIN_BLEED_MATCHES = 5
BLEED_MIN_SHARE = 0.3  # weighted share of matched n-grams that must agree
COMMON_NGRAM_WEIGHT = 0.2  # n-grams made only of filler/stopwords count less
COMMON_BLEED_WORDS = frozenset(
    {
        "i", "i'm", "you", "know", "yeah", "yes", "no", "don't", "dont", "the", "a", "an",
        "and", "it", "it's", "that", "like", "so", "um", "uh", "right", "okay", "ok", "oh",
        "well", "mean", "just", "is", "was", "to", "of", "in", "we", "think", "really",
        "what", "do", "not", "but", "this", "be", "have", "sure", "mm", "hmm", "mhm",
    }
)  # fmt: skip
BLEED_AGREE_SEC = 0.75
LOCKED_METHODS = frozenset({"hold", "manual"})  # keep placement unless align.realign
REFERENCE_METHOD = "reference"
UNCONFIRMED_HOLD = "unconfirmed_hold"
LARGE_MOVE_SEC = 1.0  # moves above this need waveform xcorr confirmation
LARGE_MOVE_MIN_PEAK = 0.1
ACOUSTIC_CONFIRM_MIN_WINDOWS = 3
_ACOUSTIC_METHODS = frozenset({"bleed_acoustic", "bleed_near_identity"})
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


def large_move_sec_from_defaults(defaults: dict[str, Any] | None) -> float:
    """``align.large_move_sec`` (moves above it are confirmed, gated and QC-checked).

    Only knobs read outside the scorer get an accessor; scorer-only knobs are read
    inline at the top of :func:`plan_conversation_alignment`.
    """
    cfg = (defaults or {}).get("align") or {}
    return float(cfg.get("large_move_sec", LARGE_MOVE_SEC))


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
    candidate_offset_sec: float | None = None
    acoustic_confirmed: bool | None = None
    skipped_reason: str | None = None


@dataclass
class AlignResult:
    plans: list[ClipAlignPlan] = field(default_factory=list)
    reference_track_id: str | None = None
    skipped_reason: str | None = None
    large_move_sec: float = LARGE_MOVE_SEC

    def summary(self) -> str:
        if self.skipped_reason:
            return self.skipped_reason
        moved = [
            p
            for p in self.plans
            if p.method not in LOCKED_METHODS and abs(p.offset_sec) > 1e-3 and not p.skipped_reason
        ]
        if not moved:
            base = f"{len(self.plans)} clips; all near identity (ref={self.reference_track_id})"
        else:
            parts = [f"{p.track_id}:{p.offset_sec:+.2f}s/{p.method}" for p in moved[:6]]
            extra = "" if len(moved) <= 6 else f" +{len(moved) - 6} more"
            base = f"{len(moved)} moved ({', '.join(parts)}{extra}); ref={self.reference_track_id}"
        notes: list[str] = []
        locked = sorted({p.track_id for p in self.plans if p.method in LOCKED_METHODS})
        if locked:
            notes.append(
                f"locked {', '.join(locked)} (same length / manifest; align.realign to re-align)"
            )
        held = [p for p in self.plans if p.method == UNCONFIRMED_HOLD]
        if held:
            notes.append(
                "held unconfirmed "
                + ", ".join(
                    f"{p.track_id}:{(p.candidate_offset_sec or 0.0):+.2f}s" for p in held[:6]
                )
            )
        skipped_reason_by_track: dict[str, str] = {}
        for p in self.plans:
            if p.skipped_reason and p.track_id not in skipped_reason_by_track:
                skipped_reason_by_track[p.track_id] = p.skipped_reason
        for track_id in sorted(skipped_reason_by_track):
            notes.append(f"skipped {track_id} ({skipped_reason_by_track[track_id]})")
        return base if not notes else f"{base}; {'; '.join(notes)}"


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
        parts = [normalize_token(w.text) for w in peer if w.confidence >= min_confidence]
        parts = [p for p in parts if p]
        for i in range(len(parts) - n + 1):
            peer_ngrams.add(" ".join(parts[i : i + n]))

    if not peer_ngrams:
        return [w for w in tokens if w.confidence >= min_confidence]

    keep = [False] * len(tokens)
    parts = [normalize_token(w.text) for w in tokens]
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


def _is_common_ngram(gram: str) -> bool:
    return all(tok in COMMON_BLEED_WORDS for tok in gram.split())


def _weighted_median(values: list[float], weights: list[float]) -> float:
    """Lower weighted median: first value whose cumulative weight reaches half the total.

    Zero total weight returns the smallest value; NaN weights fall through to the largest.
    """
    pairs = sorted(zip(values, weights, strict=True))
    half = sum(w for _v, w in pairs) / 2.0
    acc = 0.0
    for v, w in pairs:
        acc += w
        if acc >= half:
            return float(v)
    return float(pairs[-1][0])


def bleed_phrase_offsets(
    reference: list[WordToken],
    source: list[WordToken],
    *,
    n: int = NGRAM_N,
    min_confidence: float = 0.5,
    agree_sec: float = BLEED_AGREE_SEC,
    min_matches: int = MIN_BLEED_MATCHES,
    min_share: float = BLEED_MIN_SHARE,
) -> tuple[float | None, list[float], str | None]:
    """Return (median_offset, clustered_offsets, detail) when bleed n-grams agree.

    Offset is ``ref_start - src_start`` so positive means the source file's t=0
    plays later on the session clock.

    Pairing: unique (one hit) n-grams form a provisional median; each ref match
    then picks the source hit nearest that median (not always ``hits[0]``).

    Agreement rule: at least ``min_matches`` matches must cluster within
    ``agree_sec`` of the weighted median **and** carry at least ``min_share`` of
    the total weight. Weight is ``1/(ref_count*src_count)`` per n-gram, times
    ``COMMON_NGRAM_WEIGHT`` for filler-only n-grams ("i don't know").
    """
    ref_parts = [
        (normalize_token(w.text), w.start, w.end)
        for w in reference
        if w.confidence >= min_confidence and normalize_token(w.text)
    ]
    src_parts = [
        (normalize_token(w.text), w.start, w.end)
        for w in source
        if w.confidence >= min_confidence and normalize_token(w.text)
    ]
    if len(ref_parts) < n or len(src_parts) < n:
        return None, [], None

    src_index: dict[str, list[tuple[float, float]]] = {}
    for i in range(len(src_parts) - n + 1):
        gram = " ".join(p[0] for p in src_parts[i : i + n])
        src_index.setdefault(gram, []).append((src_parts[i][1], src_parts[i + n - 1][2]))

    ref_counts: collections.Counter[str] = collections.Counter()
    matches: list[tuple[str, float, list[tuple[float, float]]]] = []
    for i in range(len(ref_parts) - n + 1):
        gram = " ".join(p[0] for p in ref_parts[i : i + n])
        ref_counts[gram] += 1
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
    weights: list[float] = []
    samples: list[str] = []
    for gram, ref_start, hits in matches:
        best_hit = min(hits, key=lambda h: abs((ref_start - h[0]) - seed))
        delta = ref_start - best_hit[0]
        deltas.append(delta)
        w = 1.0 / (ref_counts[gram] * len(hits))
        weights.append(w * COMMON_NGRAM_WEIGHT if _is_common_ngram(gram) else w)
        if len(samples) < 5:
            samples.append(f"'{gram}' Δ={delta:+.2f}s")

    if len(deltas) < min_matches:
        return None, deltas, None

    center = _weighted_median(deltas, weights)
    keep = [i for i, d in enumerate(deltas) if abs(d - center) <= agree_sec]
    clustered = [deltas[i] for i in keep]
    total_w = sum(weights) or 1.0
    share = sum(weights[i] for i in keep) / total_w
    if len(clustered) < min_matches or share < min_share:
        return (
            None,
            deltas,
            (
                f"bleed rejected: {len(clustered)}/{len(deltas)} n-grams agree "
                f"(weighted share {share:.0%}; need >= {min_matches} and >= {min_share:.0%})"
            ),
        )
    med = _weighted_median(clustered, [weights[i] for i in keep])
    detail = f"{len(clustered)}/{len(deltas)} bleed n-grams (share {share:.0%}); " + "; ".join(
        samples
    )
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


def _equal_duration_units(
    units: list[tuple[Track, Clip, list[WordToken], float]],
) -> tuple[list[str], float] | None:
    track_ids = sorted({t.id for t, _c, _tok, _d in units})
    if len(track_ids) < 2:
        return None
    durs = [d for _t, _c, _tok, d in units]
    if not all(durations_match(durs[0], d) for d in durs[1:]):
        return None
    return track_ids, durs[0]


def equal_duration_dialogue(project: EpisodeProject) -> tuple[list[str], float] | None:
    """Track ids + duration when every dialogue file shares one length (likely pre-aligned)."""
    return _equal_duration_units(dialogue_align_units(project))


def _speaker_label(track: Track) -> str:
    return track.speaker or track.label or track.id


def ingest_alignment_key(track: Track, clip: Clip, *, per_clip: bool) -> str:
    """``meta.ingest_alignment`` key: ``track_id:clip_id`` per clip, else the speaker label."""
    return f"{track.id}:{clip.id}" if per_clip else _speaker_label(track)


def _speaker_key_unique(project: EpisodeProject, track: Track) -> bool:
    """True when no other dialogue track shares this track's speaker label."""
    label = _speaker_label(track)
    return (
        sum(
            1 for t in project.tracks if t.role == TrackRole.DIALOGUE and _speaker_label(t) == label
        )
        == 1
    )


def ingest_alignment_meta_key(
    project: EpisodeProject, track: Track, clip: Clip, *, multi_clip: bool
) -> str:
    """Key ingest and align write: per clip for a multi-clip track or a shared speaker label."""
    per_clip = multi_clip or not _speaker_key_unique(project, track)
    return ingest_alignment_key(track, clip, per_clip=per_clip)


def _manifest_pinned(project: EpisodeProject, track: Track, clip: Clip) -> bool:
    """True when ingest pinned this clip's offset (its own key, else a unique speaker key)."""
    meta = project.meta.ingest_alignment or {}
    entry = meta.get(ingest_alignment_key(track, clip, per_clip=True))
    if entry is None and _speaker_key_unique(project, track):
        entry = meta.get(ingest_alignment_key(track, clip, per_clip=False))
    return entry is not None and entry.align_method == "manual"


def _lock_plan(
    project: EpisodeProject,
    track: Track,
    clip: Clip,
    *,
    same_len: bool,
    pre_aligned: bool,
    ref_clips: list[Clip],
) -> ClipAlignPlan | None:
    """Lock for a manifest-pinned clip or an equal-duration set (None → score normally)."""
    if _manifest_pinned(project, track, clip):
        return ClipAlignPlan(
            track_id=track.id,
            clip_id=clip.id,
            offset_sec=clip_source_to_timeline_shift(clip) - _reference_shift_at(clip, ref_clips),
            method="manual",
            detail=(
                "ingest manifest offset pinned (session_offset_sec); "
                "locked - set align.realign to re-align"
            ),
            same_length_prior=same_len,
        )
    if same_len and pre_aligned:
        return ClipAlignPlan(
            track_id=track.id,
            clip_id=clip.id,
            offset_sec=0.0,
            method="hold",
            detail=(
                "every dialogue stem has the same file duration (likely pre-aligned); "
                "locked at identity - set align.realign to re-align"
            ),
            same_length_prior=True,
        )
    return None


def _reference_shift(ref_clips: list[Clip]) -> float:
    """Timeline-minus-source shift of the first reference clip (ingest lead-in)."""
    return clip_source_to_timeline_shift(ref_clips[0]) if ref_clips else 0.0


def _reference_shift_at(clip: Clip, ref_clips: list[Clip]) -> float:
    """Shift of the reference clip overlapping ``clip`` most on the timeline, else the first."""
    best: Clip | None = None
    best_overlap = 0.0
    for ref in ref_clips:
        overlap = min(ref.timeline_end, clip.timeline_end) - max(
            ref.timeline_start, clip.timeline_start
        )
        if overlap > best_overlap:
            best, best_overlap = ref, overlap
    return clip_source_to_timeline_shift(best) if best is not None else _reference_shift(ref_clips)


def _co_timed(clip: Clip, ref_clips: list[Clip]) -> bool:
    """True when a reference clip shares this clip's source-to-timeline shift."""
    shift = clip_source_to_timeline_shift(clip)
    return any(abs(clip_source_to_timeline_shift(r) - shift) < 1e-6 for r in ref_clips)


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
                src = project.source_by_id(clip.source_id)
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
    source_shift_sec: float = 0.0,
    sample_rate: int = 8000,
    min_rms: float = 0.01,
    cancel_check: Callable[[], bool] | None = None,
) -> AcousticOffset | None:
    """Median multi-window lag in clip-geometry sign (not estimate_offset_sec's mix delay).

    Uses ``-estimate_offset_sec(ref, source)`` so positive delays the source clip and
    negative advances it (``source_start`` trim) — matching ``offset_to_clip_geometry``.

    Source windows start at ``ref_start - source_shift_sec`` (confirm a candidate plan
    offset; the residual lag is returned).
    """
    import numpy as np

    from podcast_mcp.engines.align import estimate_offset_from_arrays, load_mono_window

    if starts is not None and source_starts is not None and len(source_starts) != len(starts):
        raise ValueError("source_starts must match starts")
    ref_dur = probe_wav_duration_sec(reference)
    src_dur = probe_wav_duration_sec(source)
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
        source_starts = [s - source_shift_sec for s in ref_starts]
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


def _confirm_large_move(
    plan: ClipAlignPlan,
    *,
    ref_audio: Path | None,
    src_audio: Path | None,
    large_move_sec: float,
    min_peak: float,
    agree_sec: float,
    confirm_fn: Callable[[Path, Path, float], AcousticOffset | None] | None,
    prev_plan: ClipAlignPlan | None,
    cancel_check: Callable[[], bool] | None = None,
) -> ClipAlignPlan:
    """Keep a move above ``large_move_sec`` only when waveform xcorr confirms it.

    Unconfirmed candidates are held at identity (``unconfirmed_hold``) and kept in
    ``candidate_offset_sec`` so a person can listen and nudge.
    """
    if (
        plan.method in LOCKED_METHODS | _ACOUSTIC_METHODS | {REFERENCE_METHOD}
        or abs(plan.offset_sec) <= large_move_sec
    ):
        return plan
    candidate = plan.offset_sec
    if (
        prev_plan is not None
        and prev_plan.candidate_offset_sec is not None
        and abs(prev_plan.candidate_offset_sec - candidate) < 1e-9
        and prev_plan.acoustic_confirmed is not None
    ):
        return replace(prev_plan)

    acoustic: AcousticOffset | None = None
    if confirm_fn is not None:
        acoustic = confirm_fn(ref_audio or Path("ref"), src_audio or Path("src"), candidate)
        why = acoustic.detail if acoustic is not None else "no correlated window"
    elif ref_audio is not None and src_audio is not None:
        try:
            acoustic = acoustic_clip_offset(
                ref_audio,
                src_audio,
                source_shift_sec=candidate,
                min_peak=min_peak,
                cancel_check=cancel_check,
            )
        except RuntimeError as exc:
            if not str(exc).startswith("acoustic confirm failed: could not decode any window"):
                raise
            why = str(exc)
        else:
            why = acoustic.detail if acoustic is not None else "no correlated window"
    else:
        why = "no audio to cross-correlate"

    if (
        acoustic is not None
        and acoustic.n_windows >= ACOUSTIC_CONFIRM_MIN_WINDOWS
        and abs(acoustic.offset_sec) <= agree_sec
    ):
        return replace(
            plan,
            offset_sec=candidate + acoustic.offset_sec,
            candidate_offset_sec=candidate,
            acoustic_confirmed=True,
            detail=f"{plan.detail}; confirmed by {acoustic.detail}",
        )
    return replace(
        plan,
        offset_sec=0.0,
        method=UNCONFIRMED_HOLD,
        candidate_offset_sec=candidate,
        acoustic_confirmed=False,
        detail=(
            f"{plan.method} candidate {candidate:+.2f}s not confirmed by waveform xcorr "
            f"({why}); held at 0 - listen and nudge if real; {plan.detail}"
        ),
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
        right = bisect_left(mids, center)
        best_i = min(right, len(mids) - 1)
        if best_i and abs(mids[best_i - 1] - center) <= abs(mids[best_i] - center):
            best_i -= 1
        best_d = abs(mids[best_i] - center)
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
    min_bleed_share: float = BLEED_MIN_SHARE,
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
        min_share=min_bleed_share,
    )

    def _plan(
        *,
        method: str,
        offset: float,
        detail: str,
        gap_offset: float | None = None,
    ) -> ClipAlignPlan:
        if bleed_off is None and bleed_detail:
            detail = f"{detail}; {bleed_detail}"
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
    # Scorer-only knobs are read inline; shared ones use *_from_defaults accessors.
    cfg = (defaults or {}).get("align") or {}
    coarse_step = float(cfg.get("coarse_step_sec", 0.5))
    fine_step = float(cfg.get("fine_step_sec", 0.02))
    ngram_n = int(cfg.get("bleed_ngram", NGRAM_N))
    realign = bool(cfg.get("realign", False))
    min_bleed = int(cfg.get("min_bleed_matches", MIN_BLEED_MATCHES))
    min_bleed_share = float(cfg.get("bleed_min_share", BLEED_MIN_SHARE))
    large_move_sec = large_move_sec_from_defaults(defaults)
    large_min_peak = float(cfg.get("large_move_min_peak", LARGE_MOVE_MIN_PEAK))
    confirm_fn = (defaults or {}).get("_align_acoustic_confirm_fn")
    # Near-identity bleed skips the stricter large-move confirmation; never above it.
    bleed_identity_sec = min(
        float(cfg.get("bleed_identity_sec", BLEED_IDENTITY_SEC)), large_move_sec
    )
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
        return AlignResult(
            skipped_reason="skipped (<2 dialogue clips)", large_move_sec=large_move_sec
        )

    pre_aligned = _equal_duration_units(units) is not None
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
    ref_clips = clips_for_track(project, ref_track.id)

    offsets: dict[tuple[str, str], ClipAlignPlan] = {}
    for track, clip, _tokens, _dur in units:
        if track.id == ref_track.id:
            offsets[(track.id, clip.id)] = ClipAlignPlan(
                track_id=track.id,
                clip_id=clip.id,
                offset_sec=0.0,
                method=REFERENCE_METHOD,
                detail="reference track",
            )

    ref_durs = [d for t, _c, _tok, d in units if t.id == ref_track.id]
    ref_tokens: list[WordToken] = []
    for t, _c, tok, _d in units:
        if t.id == ref_track.id:
            ref_tokens.extend(tok)

    def placed_intervals(
        track: Track, tokens: list[WordToken], offset: float
    ) -> list[tuple[float, float]]:
        peers = [tok for t, _c, tok, _d in units if t.id != track.id]
        own_iv = _own_speech_intervals(tokens, peers, ngram_n=ngram_n, max_word_sec=max_word_sec)
        return [(s + offset, e + offset) for s, e in own_iv]

    def rebuild_placed() -> dict[tuple[str, str], list[tuple[float, float]]]:
        placed: dict[tuple[str, str], list[tuple[float, float]]] = {}
        for track, clip, tokens, _dur in units:
            plan = offsets.get((track.id, clip.id))
            if plan is None:
                continue
            placed[(track.id, clip.id)] = placed_intervals(track, tokens, plan.offset_sec)
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
                same_len = any(durations_match(dur, rd) for rd in ref_durs)
                locked = (
                    None
                    if realign
                    else _lock_plan(
                        project,
                        track,
                        clip,
                        same_len=same_len,
                        pre_aligned=pre_aligned,
                        ref_clips=ref_clips,
                    )
                )
                if locked is not None:
                    offsets[(track.id, clip.id)] = locked
                    placed_iv[(track.id, clip.id)] = placed_intervals(
                        track, tokens, locked.offset_sec
                    )
                    prog.advance(1, message=f"Pass {pass_i + 1}: locked {clip.id}")
                    continue
                peer_ivs = [iv for (tid, _cid), iv in placed_iv.items() if tid != track.id]
                union = union_intervals(peer_ivs)
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
                    min_bleed_share=min_bleed_share,
                )
                scored = _confirm_large_move(
                    scored,
                    ref_audio=ref_audio,
                    src_audio=src_audio,
                    large_move_sec=large_move_sec,
                    min_peak=large_min_peak,
                    agree_sec=acoustic_agree_sec,
                    confirm_fn=confirm_fn,
                    prev_plan=offsets.get((track.id, clip.id)),
                    cancel_check=cancel_check,
                )
                scored.track_id = track.id
                scored.clip_id = clip.id
                offsets[(track.id, clip.id)] = scored
                # Mid-pass: later tracks see this placement in the peer union.
                placed_iv[(track.id, clip.id)] = placed_intervals(track, tokens, scored.offset_sec)
                prog.advance(1, message=f"Pass {pass_i + 1}: clip {clip.id}")
    plans = list(offsets.values())
    # Stable order: reference first, then by track/clip
    plans.sort(key=lambda p: (0 if p.method == REFERENCE_METHOD else 1, p.track_id, p.clip_id))
    return AlignResult(plans=plans, reference_track_id=ref_track.id, large_move_sec=large_move_sec)


def _clip_media_duration(project: EpisodeProject, track: Track, clip: Clip) -> float:
    media_dur = float(clip.source_end) if clip.source_end > clip.source_start else 0.0
    if track.media and track.media.duration_sec:
        media_dur = float(track.media.duration_sec)
    if clip.source_id:
        src = project.source_by_id(clip.source_id)
        if src and src.duration_sec:
            media_dur = float(src.duration_sec)
    return media_dur


def _is_whole_file_clip(
    project: EpisodeProject, clip: Clip, lane: list[Clip], media_dur: float
) -> bool:
    """True when ``clip`` is the sole reader of its media on this lane, at the file head."""
    key = clip_media_key(project, clip)
    if any(c.id != clip.id and clip_media_key(project, c) == key for c in lane):
        return False
    if clip.source_end < media_dur - DURATION_EPS_SEC:
        return False
    return clip.source_start <= DURATION_EPS_SEC or clip.timeline_start <= DURATION_EPS_SEC


def _planned_geometry(
    project: EpisodeProject,
    track: Track,
    clip: Clip,
    plan: ClipAlignPlan,
    *,
    lane: list[Clip],
    ref_shift: float,
    ref_clips: list[Clip],
    media_dur: float,
) -> tuple[float, float, float] | None:
    if (
        plan.method in (REFERENCE_METHOD, "manual")
        or (
            plan.method == "hold"
            and (
                _co_timed(clip, ref_clips)
                or abs(clip.source_start) > 1e-9
                or abs(clip.timeline_start) > 1e-9
            )
        )
        or abs(plan.offset_sec + ref_shift) < 1e-9
    ):
        # Identity: reference clips (incl. sequential extras), manifest-pinned clips,
        # held clips with existing placement (including a prior nudge), and
        # guests whose rebased offset is zero keep their placement. A virgin
        # identity hold is rebased onto the reference lead-in once.
        return clip.source_start, clip.source_end, clip.timeline_start
    if _is_whole_file_clip(project, clip, lane, media_dur):
        return offset_to_clip_geometry(plan.offset_sec + ref_shift, media_duration=media_dur)
    target_shift = plan.offset_sec + _reference_shift_at(clip, ref_clips)
    return slip_clip_to_shift(clip, target_shift, media_duration=media_dur)


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

    ref_clips = (
        clips_for_track(project, result.reference_track_id) if result.reference_track_id else []
    )
    # Plans are file-time offsets against the reference file; rebase them onto the
    # reference clip's placement (an ingest lead-in keeps reference file L at timeline 0).
    ref_shift = _reference_shift(ref_clips)
    ref_clips = [c.model_copy() for c in ref_clips]

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

        staged: list[tuple[Clip, ClipAlignPlan, tuple[float, float, float] | None]] = []
        skip: str | None = None
        for clip in clips:
            plan = by_key.get((track.id, clip.id))
            if plan is None:
                continue
            media_dur = _clip_media_duration(project, track, clip)
            geom = _planned_geometry(
                project,
                track,
                clip,
                plan,
                lane=clips,
                ref_shift=ref_shift,
                ref_clips=ref_clips,
                media_dur=media_dur,
            )
            if geom is None and skip is None:
                skip = (
                    f"clip {clip.id!r} would leave its source file after the "
                    f"{plan.offset_sec:+.1f}s shift"
                )
            staged.append((clip, plan, geom))

        if not staged:
            continue

        if skip is None:
            snap = snapshot_clip_geometry(project, clips)
            stacks_before = {
                tuple(sorted(s.clip_ids))
                for s in same_source_timeline_overlaps(project, track_ids={track.id})
            }
            for clip, _plan, geom in staged:
                assert geom is not None
                clip.source_start, clip.source_end, clip.timeline_start = geom
            new_stacks = [
                s
                for s in same_source_timeline_overlaps(project, track_ids={track.id})
                if tuple(sorted(s.clip_ids)) not in stacks_before
            ]
            if new_stacks:
                restore_clip_geometry(project, snap)
                a, b = new_stacks[0].clip_ids
                skip = f"clips {a!r} and {b!r} would stack on the same source"

        if skip:
            log.warning("align_tracks: skipping %s: %s", track.id, skip)
            for _clip, plan, _geom in staged:
                plan.skipped_reason = f"{skip}; track left unchanged"
            continue

        for clip, plan, _geom in staged:
            updated += 1
            if plan.method == "manual":
                continue  # keep the manifest's pinned meta entry
            shift = clip_source_to_timeline_shift(clip)
            session_start = max(0.0, -shift)
            content = max(0.0, shift)
            key = ingest_alignment_meta_key(
                project, track, clip, multi_clip=clips_by_track.get(track.id, 1) > 1
            )
            align_meta[key] = SpeakerIngestAlignment(
                session_start_in_file_sec=session_start,
                content_align_sec=content,
                align_method=plan.method,
            )

    project.meta.ingest_alignment = align_meta or None
    refresh_timeline_duration(project)
    return updated


def align_artifact_path(project: EpisodeProject) -> Path:
    """``artifacts/alignment/conversation_align.json`` (writer, rollback and readers share it)."""
    return project.artifacts_dir() / "alignment" / "conversation_align.json"


_PLACEMENT_KEYS = ("source_id", "source_start", "source_end", "rel_drift_sec")


def clip_drift_rows(project: EpisodeProject, reference_track_id: str) -> list[dict[str, Any]]:
    """Source range and relative drift vs the reference of each non-reference dialogue clip.

    Recorded on locked artifact rows and on ``align done`` / a person's waive so export
    QC can tell whether a clip, or a split piece of it, still sits where it was placed.
    """
    st = SessionTimeline(project)
    dialogue = {
        t.id for t in project.tracks if t.role == TrackRole.DIALOGUE and t.id != reference_track_id
    }
    return [
        {
            "track_id": c.track_id,
            "clip_id": c.id,
            "source_id": c.source_id,
            "source_start": c.source_start,
            "source_end": c.source_end,
            "rel_drift_sec": round(st.clip_relative_drift(c, reference_track_id), 4),
        }
        for c in project.clips
        if c.track_id in dialogue
    ]


def write_alignment_artifact(project: EpisodeProject, result: AlignResult) -> Path:
    path = align_artifact_path(project)
    path.parent.mkdir(parents=True, exist_ok=True)
    placed = (
        {
            (r["track_id"], r["clip_id"]): r
            for r in clip_drift_rows(project, result.reference_track_id)
        }
        if result.reference_track_id
        else {}
    )
    payload = {
        "reference_track_id": result.reference_track_id,
        "skipped_reason": result.skipped_reason,
        "large_move_sec": result.large_move_sec,
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
                "candidate_offset_sec": p.candidate_offset_sec,
                "acoustic_confirmed": p.acoustic_confirmed,
                "skipped_reason": p.skipped_reason,
                **{k: (placed.get((p.track_id, p.clip_id)) or {}).get(k) for k in _PLACEMENT_KEYS},
            }
            for p in result.plans
        ],
    }
    write_json_atomic(path, payload)
    return path


def snapshot_clip_geometry(
    project: EpisodeProject, clips: Iterable[Clip] | None = None
) -> list[tuple[str, float, float, float]]:
    source = clips if clips is not None else project.clips
    return [(c.id, c.source_start, c.source_end, c.timeline_start) for c in source]


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
        align_artifact_path(project).unlink(missing_ok=True)
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
