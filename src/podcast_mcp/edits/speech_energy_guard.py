"""Cross-track speech-energy guard for cut proposals and apply.

Transcript-guided cuts miss unlabeled words. Before session-wide ripple, check
whether another dialogue stem is audibly speaking in the mapped window and
either skip, force review, or convert to a track-local punch (silence hole,
no peer ripple). Both guards share their evidence: :func:`measure_peer_speech`
is a peer's own sound, and :func:`speech_words_in` its unsuppressed words whose
own voice reaches into the cut (:func:`word_voice_sounds_in`). The ripple speech
guard (``edits/cut_speech.py``) reads words first; this guard reads sound and
falls back to words only where a peer's sound cannot be read.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, TypeAlias

import numpy as np

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.audio_cache import (
    DIGITAL_SILENCE_DB,
    LEVEL_FRAME_SEC,
    room_floor_db,
    speech_level_db,
)
from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.join_speech import JoinSpeechConfig
from podcast_mcp.edits.session_air import lane_placements
from podcast_mcp.edits.voiced_runs import FRAME_SEC, HOP_SEC
from podcast_mcp.engines.audio_audit import (
    _RMS_SAMPLE_RATE,
    AnalysisPolicy,
    TrackRmsCacheSet,
    measure_timeline_rms_db,
    timeline_frame_levels_db,
)
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    clip_source_to_timeline_shift,
    clip_timeline_overlap_to_source,
    word_source_span,
)
from podcast_mcp.models import CutSpeechWord, EpisodeProject
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.intervals import merge_intervals
from podcast_mcp.util.timebase import SourceSec
from podcast_mcp.util.tracks import dialogue_track_ids

log = logging.getLogger(__name__)

ConflictAction = Literal["track_local", "skip", "review"]


@dataclass(frozen=True)
class SpeechEnergyGuardResult:
    """Outcome of checking other tracks over a proposed source cut."""

    blocking_track_ids: tuple[str, ...]
    action: ConflictAction | None
    """None when the cut is safe for session ripple."""

    cut_rms_db: float | None = None
    other_rms_db: dict[str, float] = field(default_factory=dict)

    @property
    def blocked(self) -> bool:
        return bool(self.blocking_track_ids)


def _guard_cfg(defaults: dict[str, Any] | None) -> dict[str, Any]:
    cfg = defaults if defaults is not None else load_defaults()
    return dict((cfg.get("tighten") or {}).get("speech_energy_guard") or {})


def speech_energy_guard_enabled(defaults: dict[str, Any] | None = None) -> bool:
    return bool(_guard_cfg(defaults).get("enabled", True))


def speech_energy_on_conflict(defaults: dict[str, Any] | None = None) -> ConflictAction:
    raw = str(_guard_cfg(defaults).get("on_conflict", "track_local")).strip().lower()
    choices: dict[str, ConflictAction] = {
        "skip": "skip",
        "review": "review",
        "track_local": "track_local",
    }
    return choices.get(raw, "track_local")


@dataclass(frozen=True)
class PeerSpeechLevels:
    """Own-sound evidence over timeline spans: which peer tracks are speaking there."""

    owner_rms_db: float | None
    peer_rms_db: dict[str, float]
    speaking: tuple[str, ...]
    unread: dict[str, list[tuple[float, float]]] = field(default_factory=dict)
    """Per peer, the spans where its own sound could not be read, so it shows nothing."""


def _sample_boundary(point: float, rate: int, origin: float) -> float:
    index = math.floor((point - origin) * rate)
    if origin + index / rate < point:
        index += 1
    return origin + index / rate


def _owned_peer_frames(
    project: EpisodeProject,
    peer_track_id: str,
    start: float,
    end: float,
    *,
    owner_track_ids: Collection[str],
    dominance_db: float,
    caches: TrackRmsCacheSet | None,
    half_open: bool = False,
) -> tuple[np.ndarray, np.ndarray] | None:
    if half_open:
        # Both readers must use the first eligible sample and the exclusive stopping index.
        cache = caches.get(peer_track_id) if caches else None
        rate = cache.sample_rate if cache else _RMS_SAMPLE_RATE
        origin = cache.timeline_offset_sec if cache else 0.0
        start, end = (
            float(np.nextafter(_sample_boundary(point, rate, origin), np.inf))
            for point in (start, end)
        )
    else:
        end = float(np.nextafter(end, np.inf))
    levels = timeline_frame_levels_db(
        project,
        peer_track_id,
        start,
        end,
        frame_sec=LEVEL_FRAME_SEC,
        hop_sec=LEVEL_FRAME_SEC,
        caches=caches,
    )
    if levels is None:
        return None
    peer = project.track_by_id(peer_track_id)
    gain = peer.gain_db if peer else 0.0
    own = levels > DIGITAL_SILENCE_DB + gain
    for tid in owner_track_ids:
        owner = timeline_frame_levels_db(
            project,
            tid,
            start,
            end,
            frame_sec=LEVEL_FRAME_SEC,
            hop_sec=LEVEL_FRAME_SEC,
            caches=caches,
        )
        if owner is None:
            continue
        track = project.track_by_id(tid)
        owner_gain = track.gain_db if track else 0.0
        size = min(levels.size, owner.size)
        own[:size] &= ~(
            (owner[:size] > DIGITAL_SILENCE_DB + owner_gain)
            & (owner[:size] - levels[:size] >= dominance_db)
        )
    return levels, own


def _peer_speaks_near_span(
    project: EpisodeProject,
    peer_track_id: str,
    span: tuple[float, float],
    *,
    owner_track_ids: Collection[str],
    dominance_db: float,
    caches: TrackRmsCacheSet | None,
    admissible_span: tuple[float, float] | None = None,
) -> bool | None:
    config = JoinSpeechConfig()
    start, end = (
        admissible_span
        if admissible_span is not None
        else (max(0.0, span[0] - config.pad_sec), span[1] + config.pad_sec)
    )
    if admissible_span is None and start > 0.0:
        start = float(np.nextafter(start, np.inf))
    track = project.track_by_id(peer_track_id)
    gain = track.gain_db if track else 0.0
    extent = max(
        (clip.timeline_end for clip in clips_for_track(project, peer_track_id)),
        default=track.media.duration_sec if track and track.media else None,
    )
    if extent is not None:
        end = min(end, extent)

    coverage = merge_intervals(
        ((part.tl_start, part.tl_end) for part in lane_placements(project, track)) if track else (),
        gap=0.0,
    )

    def covered(lo: float, size: int, *, sealed: bool) -> np.ndarray:
        cache = caches.get(peer_track_id) if caches else None
        if sealed:
            lo = _sample_boundary(
                lo,
                cache.sample_rate if cache else _RMS_SAMPLE_RATE,
                cache.timeline_offset_sec if cache else 0.0,
            )
        elif cache:
            lo = (
                cache.timeline_offset_sec
                + math.floor((lo - cache.timeline_offset_sec) * cache.sample_rate)
                / cache.sample_rate
            )
        starts = lo + np.arange(size) * LEVEL_FRAME_SEC
        mask = np.zeros(size, dtype=bool)
        for left, right in coverage:
            mask |= (starts >= left) & (starts + LEVEL_FRAME_SEC <= right)
        return mask

    def frames(
        lo: float, hi: float, *, sealed: bool = False
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
        if hi - lo < LEVEL_FRAME_SEC - 1e-9:
            return None
        evidence = _owned_peer_frames(
            project,
            peer_track_id,
            lo,
            hi,
            owner_track_ids=owner_track_ids,
            dominance_db=dominance_db,
            caches=caches,
            half_open=sealed,
        )
        if evidence is None:
            return None
        levels, own = evidence
        reference = covered(lo, levels.size, sealed=sealed)
        if lo + levels.size * LEVEL_FRAME_SEC < hi - 1e-9:
            tail = _owned_peer_frames(
                project,
                peer_track_id,
                hi - LEVEL_FRAME_SEC,
                hi,
                owner_track_ids=owner_track_ids,
                dominance_db=dominance_db,
                caches=caches,
                half_open=sealed,
            )
            if tail is None:
                return None
            levels = np.concatenate((levels, tail[0]))
            own = np.concatenate((own, tail[1]))
            reference = np.concatenate(
                (reference, covered(hi - LEVEL_FRAME_SEC, tail[0].size, sealed=sealed))
            )
        return levels, own, reference

    before = frames(max(0.0, start - 5.0), start)
    after = frames(end, min(end + 5.0, extent) if extent is not None else end + 5.0)
    unavailable = False
    block_start = start
    while block_start < end - 1e-9:
        block_end = min(block_start + 2.0, end)
        evidence = frames(
            max(start, min(block_start, block_end - LEVEL_FRAME_SEC))
            if admissible_span is not None
            else min(block_start, block_end - LEVEL_FRAME_SEC),
            block_end,
            sealed=admissible_span is not None,
        )
        if evidence is None:
            unavailable = True
        else:
            levels, own, _ = evidence
            if not bool(own.any()):
                block_start = block_end
                continue
            nearby = (
                (before, after)
                if end - start <= 2.0
                else (before,)
                if block_start - start < end - block_end
                else (after,)
            )
            references = [evidence, *(part for part in nearby if part is not None)]
            upper = max(
                (
                    speech + gain
                    for local, mask, _ in references
                    if (speech := speech_level_db(local[mask] - gain, min_live_sec=0.0)) is not None
                ),
                default=None,
            )
            room_parts = [local[mask] for local, _, mask in references if bool(mask.any())]
            if upper is not None and room_parts:
                room = room_floor_db(np.concatenate(room_parts))
                floor = max(upper - config.speech_dynamic_db, room + 6.0)
                if upper < room + 6.0:
                    if room > upper and any(
                        bool(((local > DIGITAL_SILENCE_DB + gain) & ~mask).any())
                        for local, mask, _ in references
                    ):
                        return True
                    unavailable = True
                elif bool((own & (levels >= floor)).any()):
                    return True
            else:
                unavailable = True
        block_start = block_end
    return None if unavailable else False


def measure_peer_speech(
    project: EpisodeProject,
    timeline_spans: Sequence[tuple[float, float]],
    *,
    owner_track_ids: Collection[str],
    peer_track_ids: Iterable[str],
    defaults: dict[str, Any] | None = None,
    caches: TrackRmsCacheSet | None = None,
    _admissible_spans: Sequence[tuple[float, float]] | None = None,
) -> PeerSpeechLevels | None:
    """Peers whose own sound is speech in a span: at audible level, not owner bleed.

    Local 10 ms frames use the peer's own speech and room levels, excluding concurrent
    owner bleed. Whole-span means remain diagnostics and decide only when frames are
    unavailable or cannot separate speech from room. ``None`` when no span is at least
    ``min_overlap_sec`` long. Internal ``_admissible_spans`` seals positive evidence
    to the exact half-open query spans. Calibration remains local to played audio.
    """
    if _admissible_spans is not None and (
        not _admissible_spans
        or tuple(_admissible_spans) != tuple(timeline_spans)
        or any(not math.isfinite(s) or not math.isfinite(e) or e <= s for s, e in _admissible_spans)
    ):
        raise CodedValueError(
            "Peer detection support must match the exact positive query spans.",
            code="invalid_range",
        )
    cfg = _guard_cfg(defaults)
    policy = AnalysisPolicy.from_defaults(defaults)
    min_other = float(cfg.get("min_other_rms_db", policy.audibility_rms_db))
    dominance = float(cfg.get("dominance_db", 3.0))
    min_overlap = float(cfg.get("min_overlap_sec", 0.03))
    checked = [(s, e) for s, e in timeline_spans if e - s >= min_overlap]
    if not checked:
        return None

    span_owner_rms = [
        max(
            (
                r
                for r in (
                    measure_timeline_rms_db(project, tid, s, e, caches=caches)
                    for tid in owner_track_ids
                )
                if r is not None
            ),
            default=None,
        )
        for s, e in checked
    ]
    owner_rms = max((r for r in span_owner_rms if r is not None), default=None)

    peer_rms: dict[str, float] = {}
    speaking: list[str] = []
    unread: dict[str, list[tuple[float, float]]] = {}
    for tid in peer_track_ids:
        if tid in owner_track_ids:
            continue
        speaks = False
        for (tl_start, tl_end), span_owner in zip(checked, span_owner_rms, strict=True):
            rms = measure_timeline_rms_db(project, tid, tl_start, tl_end, caches=caches)
            if rms is None:
                unread.setdefault(tid, []).append((tl_start, tl_end))
                continue
            if tid not in peer_rms or rms > peer_rms[tid]:
                peer_rms[tid] = rms
            calibrated = _peer_speaks_near_span(
                project,
                tid,
                (tl_start, tl_end),
                owner_track_ids=owner_track_ids,
                dominance_db=dominance,
                caches=caches,
                admissible_span=(tl_start, tl_end) if _admissible_spans is not None else None,
            )
            if calibrated is None:
                calibrated = rms >= min_other and (
                    span_owner is None or span_owner - rms < dominance
                )
            speaks |= calibrated
        if speaks:
            speaking.append(tid)
    return PeerSpeechLevels(
        owner_rms_db=owner_rms,
        peer_rms_db=peer_rms,
        speaking=tuple(speaking),
        unread=unread,
    )


def word_voice_sounds_in(
    project: EpisodeProject,
    track_id: str,
    word_span: tuple[float, float],
    span: tuple[float, float],
) -> bool:
    """Whether a word's own voice on ``track_id`` sounds inside timeline ``span``.

    ASR stretches a word's span over the silence beside its voice, so the span alone
    does not show that ``span`` holds any of it. The word's loudest frame on its own
    track is its voice level, and a frame of ``span`` is that voice when it sits within
    the speech range of that level (``JoinSpeechConfig.speech_dynamic_db``). Another
    speaker's bleed on this mic is not discounted: it is no louder than the word's own
    quiet start or end, so telling them apart would hide real speech, and a false
    positive only asks. Frames are the tighten grid (``voiced_runs.FRAME_SEC`` every
    ``HOP_SEC``). Audio that cannot be read counts as voice, so a missing file never
    hides speech.
    """

    def levels(start: float, end: float) -> np.ndarray | None:
        return timeline_frame_levels_db(
            project, track_id, start, end, frame_sec=FRAME_SEC, hop_sec=HOP_SEC
        )

    word = levels(*word_span)
    inside = levels(*span)
    if word is None or inside is None:
        return True
    return bool((inside >= float(word.max()) - JoinSpeechConfig().speech_dynamic_db).any())


def _voiced_in_parts(
    project: EpisodeProject,
    track_id: str,
    word: CutSpeechWord,
    parts: Sequence[tuple[float, float]],
) -> bool:
    span = (word.timeline_start, word.timeline_end)
    return any(
        word_voice_sounds_in(project, track_id, span, (a, b))
        for start, end in parts
        if (a := max(start, span[0])) < (b := min(end, span[1]))
    )


def speech_words_in(
    project: EpisodeProject,
    track_id: str,
    parts: Sequence[tuple[float, float]],
    min_overlap: float,
    *,
    voiced: bool,
) -> list[CutSpeechWord]:
    """``track_id``'s unsuppressed, unignored words overlapping timeline ``parts``.

    A word counts once it overlaps a part by ``min_overlap`` (or by all of itself
    when shorter). ``voiced`` keeps only words whose own voice sounds where they
    meet a part (:func:`word_voice_sounds_in`).
    """
    words: list[CutSpeechWord] = []
    for clip in clips_for_track(project, track_id):
        sources = [
            source
            for start, end in parts
            if (source := clip_timeline_overlap_to_source(clip, start, end)) is not None
        ]
        if not sources:
            continue
        transcript = project.transcript_for_source(clip.track_id, clip.source_id)
        if transcript is None:
            continue
        shift = clip_source_to_timeline_shift(clip)
        for word in transcript.words:
            if word.suppressed or word.ignored or word.suspect_hallucination:
                continue
            w_start, w_end = word_source_span(word.start, word.end)
            overlap = max(min(w_end, hi) - max(w_start, lo) for lo, hi in sources)
            if overlap <= 0 or overlap < min(min_overlap, w_end - w_start) - 1e-9:
                continue
            words.append(
                CutSpeechWord(
                    text=word.text,
                    timeline_start=w_start + shift,
                    timeline_end=w_end + shift,
                )
            )
    if voiced:
        words = [w for w in words if _voiced_in_parts(project, track_id, w, parts)]
    return sorted(words, key=lambda w: w.timeline_start)


def guard_min_overlap_sec(defaults: dict[str, Any] | None = None) -> float:
    """Shortest overlap with a removed span that counts as cutting speech."""
    return float(_guard_cfg(defaults).get("min_overlap_sec", 0.03))


def assess_cross_track_speech(
    project: EpisodeProject,
    cut_track_id: str,
    src_start: float,
    src_end: float,
    *,
    defaults: dict[str, Any] | None = None,
    caches: TrackRmsCacheSet | None = None,
    _admissible_spans: Sequence[tuple[float, float]] | None = None,
) -> SpeechEnergyGuardResult:
    """Return tracks that are speaking over the cut's mapped timeline window.

    A peer's own sound decides. Where it cannot be read (no stem or source audio),
    the peer's unsuppressed words whose own voice is in the window decide instead.
    """
    if src_end <= src_start or not speech_energy_guard_enabled(defaults):
        return SpeechEnergyGuardResult(blocking_track_ids=(), action=None)

    spans = SessionTimeline(project).map_source_span(
        cut_track_id, SourceSec(src_start), SourceSec(src_end)
    )
    # A track-local hole inside the gap splits it into several mapped spans;
    # peer speech in any span at or above min_overlap can block, not just the
    # largest one (#793).
    levels = measure_peer_speech(
        project,
        spans,
        owner_track_ids=(cut_track_id,),
        peer_track_ids=dialogue_track_ids(project),
        defaults=defaults,
        caches=caches,
        _admissible_spans=_admissible_spans,
    )
    if levels is None:
        return SpeechEnergyGuardResult(blocking_track_ids=(), action=None)
    min_overlap = guard_min_overlap_sec(defaults)
    blocking = levels.speaking + tuple(
        tid
        for tid, unread in levels.unread.items()
        if tid not in levels.speaking
        and speech_words_in(project, tid, unread, min_overlap, voiced=True)
    )
    if not blocking:
        return SpeechEnergyGuardResult(
            blocking_track_ids=(),
            action=None,
            cut_rms_db=levels.owner_rms_db,
            other_rms_db=levels.peer_rms_db,
        )
    return SpeechEnergyGuardResult(
        blocking_track_ids=blocking,
        action=speech_energy_on_conflict(defaults),
        cut_rms_db=levels.owner_rms_db,
        other_rms_db=levels.peer_rms_db,
    )


class PeerSpeechBlocked(ValueError):
    """``on_conflict: skip`` and peers are speaking over the cut."""

    def __init__(self, peers: tuple[str, ...]) -> None:
        super().__init__(
            f"cut blocked: other track(s) speaking in window ({', '.join(peers)}); "
            "leave in or use a track-local punch"
        )
        self.peers = peers


@dataclass(frozen=True)
class ResolvedCutScope:
    cause: Literal["session_clear", "intentional_track", "peer_speech", "speaker_bleed"]
    guard: SpeechEnergyGuardResult | None = None

    @property
    def scope(self) -> Literal["session", "track"]:
        scopes: dict[str, Literal["session", "track"]] = {
            "session_clear": "session",
            "intentional_track": "track",
            "peer_speech": "track",
            "speaker_bleed": "track",
        }
        return scopes[self.cause]


@dataclass(frozen=True)
class CutScopeUnavailable:
    """Peer assessment failed without selecting an executable cut scope."""


CutScopeResolution: TypeAlias = ResolvedCutScope | CutScopeUnavailable


def resolve_cut_scope(
    project: EpisodeProject,
    cut_track_id: str,
    src_start: float,
    src_end: float,
    *,
    requested_scope: str = "session",
    defaults: dict[str, Any] | None = None,
    caches: TrackRmsCacheSet | None = None,
    _admissible_spans: Sequence[tuple[float, float]] | None = None,
) -> CutScopeResolution:
    """Resolve current cut scope or report unavailable peer assessment."""
    if requested_scope == "track":
        return ResolvedCutScope("intentional_track")

    try:
        from podcast_mcp.engines.speaker_id import (
            assess_speaker_cut_role,
            load_all_profiles,
        )
        from podcast_mcp.transcript_context import load_transcript_context

        if load_all_profiles(project):
            ctx = load_transcript_context(project.workspace_path())
            speaker = assess_speaker_cut_role(
                project,
                cut_track_id,
                src_start,
                src_end,
                ctx.speaker_id,
            )
            if speaker and speaker.get("role") == "bleed":
                return ResolvedCutScope("speaker_bleed")
    except Exception as exc:
        log.debug("speaker cut scope guard skipped: %s", exc, exc_info=True)

    try:
        guard = assess_cross_track_speech(
            project,
            cut_track_id,
            src_start,
            src_end,
            defaults=defaults,
            caches=caches,
            _admissible_spans=_admissible_spans,
        )
    except (OSError, ValueError):
        return CutScopeUnavailable()
    if not guard.blocked:
        return ResolvedCutScope("session_clear", guard)
    # track_local and review: never session-ripple over live peer speech.
    return ResolvedCutScope("peer_speech", guard)
