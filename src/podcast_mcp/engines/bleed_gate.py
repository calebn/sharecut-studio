from __future__ import annotations

import json
import math
import wave
from contextlib import suppress
from dataclasses import dataclass
from functools import cached_property, lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.engines.envelope_lag import (
    LEVEL_FLOOR_DB,
    MIN_CORRELATION,
    MIN_NULL_MARGIN,
    NULL_SHIFTS_SEC,
    envelope_lag,
    level_envelope_db,
)
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    clip_source_to_timeline_shift,
    clip_timeline_overlap_to_source,
)
from podcast_mcp.engines.ungated_audio import raw_evidence_layout_reason, raw_timeline_samples
from podcast_mcp.models import EpisodeProject, TranscriptGateScope, TranscriptWord
from podcast_mcp.util.dsp import bool_runs, bridge_short_dips, frame_rms_db_stream
from podcast_mcp.util.intervals import (
    HalfOpenIntervalIndex,
    intersect_intervals,
    merge_intervals,
    subtract_intervals,
)
from podcast_mcp.util.process import CalledProcessError
from podcast_mcp.util.project_state import file_revision
from podcast_mcp.util.timebase import SourceSec, TimelineSec
from podcast_mcp.util.tracks import track_audio_path

BLEED_GATE_REV = 8
EVIDENCE_RATE = 8000
GATE_FADE_SEC = 0.012
_LEVEL_FRAME_SEC = 0.1
_MAX_PATH_LAG_SEC = 0.3
_MIN_PATH_FRAMES = 3000
_CONTOUR_SEC = 0.5
_PEER_OPEN_DB = -60.0
_COPY_HOLD_SEC = 0.05
_ONSET_REACH_SEC = 0.2
_OWN_MARGIN_DB = 4.0
_OWN_HOLD_MARGIN_DB = 2.0
_MIN_OWN_SEC = 0.05
_TIMBRE_SHARE = 0.9
_TIMBRE_BAND_HZ = (80, 3000)
_TIMBRE_SMOOTH_BINS = 15
_LIKENESS_FRAMES = 400
_OWNER_FRAME_SEC = 0.02
_OWNER_HOP_SEC = 0.01
_OWNER_FLOOR_DB = -80.0
_OWNER_FLOOR_PERCENTILE = 10
_OWNER_FLOOR_MARGIN_DB = 6
_OWNER_BRIDGE_FRAMES = 15


@dataclass(frozen=True)
class BleedGatePlan:
    attenuation_spans: tuple[tuple[float, float], ...] = ()
    protected_spans: tuple[tuple[float, float], ...] = ()
    reasons: tuple[str, ...] = ()
    fade_sec: float = GATE_FADE_SEC
    attenuation_db: float = AnalysisPolicy.bleed_attenuation_db

    @cached_property
    def _attenuation_index(self) -> HalfOpenIntervalIndex:
        return HalfOpenIntervalIndex.build(self.attenuation_spans)

    def gains_for_frames(self, first_frame: int, count: int, rate: int) -> np.ndarray:
        """Gain on the absolute clock, with transitions inside justified attenuation."""
        gains = np.ones(count, dtype=np.float32)
        floor = 10 ** (-self.attenuation_db / 20)
        overlapping = self._attenuation_index.overlapping_ordinals(
            first_frame / rate, (first_frame + count) / rate
        )
        if not overlapping:
            return gains
        positions = np.arange(first_frame, first_frame + count)
        for ordinal in overlapping:
            start, end = self.attenuation_spans[ordinal]
            lo, hi = math.ceil(start * rate), math.ceil(end * rate)
            width = min(round(self.fade_sec * rate), (hi - lo) // 2)
            selected = (positions >= lo) & (positions < hi)
            values = np.full(count, floor, dtype=np.float32)
            if width:
                ramp = np.maximum(
                    np.clip((lo + width - positions) / width, 0, 1),
                    np.clip((positions - (hi - width - 1)) / width, 0, 1),
                )
                values = (floor + (1 - floor) * ramp).astype(np.float32)
            gains[selected] = np.minimum(gains[selected], values[selected])
        return gains


@dataclass(frozen=True)
class BleedWordMapping:
    source_id: str | None
    word: TranscriptWord
    spans: tuple[tuple[TimelineSec, TimelineSec], ...]
    boundary_spans: tuple[tuple[TimelineSec, TimelineSec], ...]

    @property
    def is_candidate(self) -> bool:
        word = self.word
        return bool(
            word.suppressed
            and word.audibility_status == "bleed"
            and word.dominant_track
            and word.end > word.start
            and not word.ignored
            and not word.audibility_locked
            and self.spans
        )


@dataclass(frozen=True)
class BleedGateGeometry:
    words: tuple[BleedWordMapping, ...]
    untranscribed_spans: tuple[tuple[float, float], ...]


def bleed_gate_geometry(project: EpisodeProject, track_id: str) -> BleedGateGeometry:
    """Map eligibility and protection metadata through selected recordings only."""
    timeline = SessionTimeline(project)
    placements = timeline.lane_clip_spans(track_id)
    transcripts = project.selected_source_transcripts(track_id)
    transcribed = {source_id for source_id, _ in transcripts}
    words: list[BleedWordMapping] = []
    for source_id, transcript in transcripts:
        bounds = [(SourceSec(word.start), SourceSec(word.end)) for word in transcript.words]
        spans = (
            timeline.map_selected_source_spans(track_id, source_id, bounds)
            if placements
            else [[(TimelineSec(a), TimelineSec(b))] if b > a else [] for a, b in bounds]
        )
        boundaries = (
            timeline.map_selected_word_spans(track_id, source_id, bounds)
            if placements
            else timeline.map_word_spans(track_id, bounds)
        )
        words.extend(
            BleedWordMapping(source_id, word, tuple(mapped), tuple(boundary))
            for word, mapped, boundary in zip(transcript.words, spans, boundaries, strict=True)
        )
    return BleedGateGeometry(
        tuple(words),
        tuple(
            (float(span.timeline_start), float(span.timeline_end))
            for span in placements
            if span.clip.source_id not in transcribed
        ),
    )


def gate_scope_for_window(
    project: EpisodeProject, track_id: str, start: float, end: float
) -> list[TranscriptGateScope]:

    scopes: list[TranscriptGateScope] = []
    clips = SessionTimeline(project).lane_clip_spans(track_id)
    for span in clips:
        mapped = clip_timeline_overlap_to_source(span.clip, start, end)
        if mapped is not None:
            scopes.append(
                TranscriptGateScope(
                    start_s=float(mapped[0]), end_s=float(mapped[1]), source_id=span.clip.source_id
                )
            )
    if not clips and end > start:
        scopes.append(TranscriptGateScope(start_s=start, end_s=end))
    return merge_gate_scopes(scopes)


def merge_gate_scopes(scopes: list[TranscriptGateScope]) -> list[TranscriptGateScope]:
    """Canonical source selections make repeated and overlapping applies idempotent."""
    sources = sorted({scope.source_id for scope in scopes}, key=lambda source: source or "")
    return [
        TranscriptGateScope(start_s=start, end_s=end, source_id=source)
        for source in sources
        for start, end in merge_intervals(
            (scope.start_s, scope.end_s) for scope in scopes if scope.source_id == source
        )
    ]


def _scope_intervals(project: EpisodeProject, track_id: str) -> list[tuple[float, float]]:
    track = project.track_by_id(track_id)
    if track is None or track.transcript_gate_scope is None:
        return [(0, math.inf)]
    clips = SessionTimeline(project).lane_clip_spans(track_id)
    if not clips:
        return [
            (scope.start_s, scope.end_s)
            for scope in track.transcript_gate_scope
            if not scope.source_id
        ]
    intervals: list[tuple[float, float]] = []
    for scope in track.transcript_gate_scope:
        for span in clips:
            if span.clip.source_id != scope.source_id:
                continue
            start, end = (
                max(scope.start_s, float(span.source_start)),
                min(scope.end_s, float(span.source_end)),
            )
            if end > start:
                shift = clip_source_to_timeline_shift(span.clip)
                intervals.append((start + shift, end + shift))
    return merge_intervals(intervals)


def _owner_protection(
    samples: np.ndarray,
    seeds: list[tuple[float, float]],
    foreign: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Own words plus the voiced runs touching them, stopping where a peer owns the speech."""
    frame, hop = round(_OWNER_FRAME_SEC * EVIDENCE_RATE), round(_OWNER_HOP_SEC * EVIDENCE_RATE)
    if not seeds or samples.size < frame:
        return seeds
    levels = frame_rms_db_stream(
        (samples[first : first + EVIDENCE_RATE] for first in range(0, samples.size, EVIDENCE_RATE)),
        frame,
        hop,
    )
    floor = max(
        _OWNER_FLOOR_DB,
        float(np.percentile(levels, _OWNER_FLOOR_PERCENTILE)) + _OWNER_FLOOR_MARGIN_DB,
    )
    active = bridge_short_dips(levels > floor, _OWNER_BRIDGE_FRAMES)
    for start, end in foreign:
        active[max(0, math.ceil(start / _OWNER_HOP_SEC)) : math.floor(end / _OWNER_HOP_SEC)] = False
    runs = [
        (lo * _OWNER_HOP_SEC, hi * _OWNER_HOP_SEC + _OWNER_HOP_SEC) for lo, hi in bool_runs(active)
    ]
    expanded = list(seeds)
    seed_index = HalfOpenIntervalIndex.build(seeds)
    for start, end in runs:
        if seed_index.overlaps(start, end):
            expanded.append((start, end))
    return merge_intervals(expanded)


def _levels_db(samples: np.ndarray) -> np.ndarray:
    """Level envelope on the owner hop grid, long enough to span a syllable."""
    return level_envelope_db(
        samples, sample_rate=EVIDENCE_RATE, frame_sec=_LEVEL_FRAME_SEC, hop_sec=_OWNER_HOP_SEC
    )


def _hop_mask(size: int, spans: list[tuple[float, float]], pad_sec: float = 0.0) -> np.ndarray:
    mask = np.zeros(size, dtype=bool)
    for start, end in spans:
        lo = max(0, math.floor((start - pad_sec) / _OWNER_HOP_SEC))
        mask[lo : max(lo, math.ceil((end + pad_sec) / _OWNER_HOP_SEC))] = True
    return mask


def _syllable_contour(levels: np.ndarray) -> np.ndarray:
    """Levels less their half-second mean: syllables, not when someone talks."""
    clipped = np.maximum(levels, _PEER_OPEN_DB)
    width = round(_CONTOUR_SEC / _OWNER_HOP_SEC) | 1
    padded = np.pad(clipped, width // 2, mode="edge")
    return clipped - np.convolve(padded, np.ones(width) / width, mode="valid")


def _path_lag(own: np.ndarray, peer: np.ndarray, spans: list[tuple[float, float]]) -> int | None:
    """Hops by which the peer's own track trails its copy here, if levels prove a copy.

    Zoom delivers a remote speaker's track well after the same voice reaches a mic in
    the room (about 140 ms on the lab tape), and the room colours the copy, so the
    copy is found in the level envelope at the best lag, against shifted nulls.

    Two voices that start and stop together also correlate in level, so only the
    syllable contour is compared, and a path needs 30 s of frames around the peer's
    words. In synthetic trials of 200 pairs each, independent voices and voices that
    start and stop together never passed with 30 s, whether the words were scattered
    or one long phrase, and true copies always did. At 20 s, 8 in 200 co-timed long
    phrases still passed. Below the minimum the detector abstains, as it does when
    the best lag is not a peak inside the search (#1068).
    """
    found = envelope_lag(
        _syllable_contour(own),
        _syllable_contour(peer),
        np.flatnonzero(_hop_mask(own.size, spans, _MAX_PATH_LAG_SEC)),
        reach=round(_MAX_PATH_LAG_SEC / _OWNER_HOP_SEC),
        hop_sec=_OWNER_HOP_SEC,
        min_frames=_MIN_PATH_FRAMES,
    )
    return found.lag if found is not None and found.supported else None


def _frame_spans(runs: list[tuple[int, int]], *, whole_frame: bool) -> list[tuple[float, float]]:
    """Seconds read by any frame of each run, or only the seconds every frame read covers."""
    lead, tail = (
        (0.0, _LEVEL_FRAME_SEC)
        if whole_frame
        else (_LEVEL_FRAME_SEC - _OWNER_HOP_SEC, _OWNER_HOP_SEC)
    )
    spans = [(lo * _OWNER_HOP_SEC + lead, (hi - 1) * _OWNER_HOP_SEC + tail) for lo, hi in runs]
    return [(start, end) for start, end in spans if end > start]


def _fine_spectra(samples: np.ndarray, frames: np.ndarray) -> np.ndarray:
    """Unit vectors of each level frame's log spectrum less its smooth envelope.

    What is left is the harmonic and formant detail of whoever is speaking, which a
    room copy keeps and another voice does not.
    """
    width = round(_LEVEL_FRAME_SEC * EVIDENCE_RATE)
    hop = round(_OWNER_HOP_SEC * EVIDENCE_RATE)
    index = np.clip(frames[:, None] * hop + np.arange(width)[None, :], 0, max(0, samples.size - 1))
    band = slice(
        round(_TIMBRE_BAND_HZ[0] * _LEVEL_FRAME_SEC), round(_TIMBRE_BAND_HZ[1] * _LEVEL_FRAME_SEC)
    )
    window = np.hanning(width)
    padded = samples if samples.size else np.zeros(1)
    spectra = np.log(np.abs(np.fft.rfft(padded[index] * window, axis=1))[:, band] + 1e-9)
    kernel = np.ones(_TIMBRE_SMOOTH_BINS) / _TIMBRE_SMOOTH_BINS
    smooth = np.apply_along_axis(np.convolve, 1, spectra, kernel, mode="same")
    fine = spectra - smooth
    fine -= fine.mean(axis=1, keepdims=True)
    return fine / (np.linalg.norm(fine, axis=1, keepdims=True) + 1e-12)


@dataclass(frozen=True, eq=False)
class _PeerCopy:
    """A peer's verified copy on this lane: its delay, level and timbre there."""

    levels: np.ndarray
    samples: np.ndarray
    lag: int
    coupling_db: float = 0.0
    likeness: float = 1.0

    def direct(self, size: int) -> np.ndarray:
        """The peer's direct-track levels moved onto this lane's clock."""
        out = np.full(size, LEVEL_FLOOR_DB)
        lo, hi = max(0, -self.lag), min(size, self.levels.size - self.lag)
        out[lo:hi] = self.levels[lo + self.lag : hi + self.lag]
        return out

    def reach(self, size: int) -> np.ndarray:
        """The direct-track level the copy here can carry in each frame.

        The copy rings on in the room after the peer's gate shuts, so frames read
        the direct track held briefly. Where the direct track was gated shut within
        the last level frame, its level is diluted or missing while the copy may
        already carry the peer's onset, so those frames also read ahead.
        """
        direct = self.direct(size)
        hop = _OWNER_HOP_SEC
        hold = round(_COPY_HOLD_SEC / hop)
        held = _sliding_max(direct, hold, hold)
        onset = _sliding_max(-direct, round(_LEVEL_FRAME_SEC / hop), 0) >= -_PEER_OPEN_DB
        ahead = _sliding_max(direct, 0, round(_ONSET_REACH_SEC / hop))
        return np.where(onset, np.maximum(held, ahead), held)

    def power(self, size: int, *, held: bool) -> np.ndarray:
        """Power of the copy on this lane, frame by frame or as far as it can reach."""
        level = self.reach(size) if held else self.direct(size)
        return 10 ** ((level + self.coupling_db) / 10)

    def similarity(self, own_samples: np.ndarray, frames: np.ndarray) -> np.ndarray:
        """Per frame, how much this lane's fine spectrum matches the peer's at the lag."""
        return np.sum(
            _fine_spectra(own_samples, frames) * _fine_spectra(self.samples, frames + self.lag),
            axis=1,
        )


def _sliding_max(levels: np.ndarray, before: int, after: int) -> np.ndarray:
    padded = np.pad(levels, (before, after), constant_values=LEVEL_FLOOR_DB)
    return np.lib.stride_tricks.sliding_window_view(padded, before + after + 1).max(axis=1)


def _peer_copy(
    own: np.ndarray,
    own_samples: np.ndarray,
    peer: np.ndarray,
    peer_samples: np.ndarray,
    spans: list[tuple[float, float]],
    own_words: list[tuple[float, float]],
) -> _PeerCopy | None:
    """The lag, then the copy's level and timbre on this mic where only the peer speaks.

    The coupling is the median lane-to-direct level over the louder half of the
    peer's open frames, away from this lane's own words, so the lane's noise floor
    and any overlapping own speech do not move it. On the lab tape it is about
    -19 dB for Audra on Caleb's mic. The likeness is the median fine-spectrum match
    on frames at that level; the room and call software blur it (0.42 on the lab).
    """
    lag = _path_lag(own, peer, spans)
    if lag is None:
        return None
    reach = _PeerCopy(peer, peer_samples, lag).reach(own.size)
    frames = (
        _hop_mask(own.size, spans)
        & ~_hop_mask(own.size, own_words, _MAX_PATH_LAG_SEC)
        & (reach > _PEER_OPEN_DB)
        & (own > LEVEL_FLOOR_DB)
    )
    if not frames.any():
        return None
    loud = frames & (reach >= np.median(reach[frames]))
    coupling = float(np.median(own[loud] - reach[loud]))
    typical = np.flatnonzero(loud & (np.abs(own - reach - coupling) < _OWN_HOLD_MARGIN_DB))
    sample = typical[:: max(1, typical.size // _LIKENESS_FRAMES)]
    copy = _PeerCopy(peer, peer_samples, lag, coupling)
    likeness = float(np.median(copy.similarity(own_samples, sample))) if sample.size else 1.0
    return _PeerCopy(peer, peer_samples, lag, coupling, likeness)


def _own_voice(
    own: np.ndarray, own_samples: np.ndarray, copies: list[_PeerCopy]
) -> list[tuple[float, float]]:
    """Seconds where this lane's speaker is heard over the peers' copies.

    The expected level is the copies plus this mic's own noise floor. A sound that
    stands the own margin above it for a syllable is a candidate, held through
    neighbouring frames above the hold margin and through short dips, so a short
    "mm" is kept whole. The copy's level alone wanders several dB with the peer's
    phonemes and the call software's noise suppression, so a candidate is the copy,
    not the lane's speaker, only when its fine spectrum matches a peer's direct track
    at least nine tenths as well as that copy usually does.
    Transcript words play no part, so untranscribed backchannels, laughs, and words
    reconciliation gave to a peer are kept too.
    """
    opened = own[own > LEVEL_FLOOR_DB]
    noise = 10 ** (
        (float(np.percentile(opened, _OWNER_FLOOR_PERCENTILE)) if opened.size else LEVEL_FLOOR_DB)
        / 10
    )
    reach = sum((copy.power(own.size, held=True) for copy in copies), np.zeros(own.size))
    excess = own - 10 * np.log10(reach + noise)

    audible = [copy.power(own.size, held=False) > noise for copy in copies]

    def carries(index: int, lo: int, hi: int) -> bool:
        heard = np.flatnonzero(audible[index][lo:hi]) + lo
        if heard.size == 0:
            return False
        copy = copies[index]
        return float(np.median(copy.similarity(own_samples, heard))) >= (
            _TIMBRE_SHARE * copy.likeness
        )

    least = round(_MIN_OWN_SEC / _OWNER_HOP_SEC)
    hot = excess > _OWN_MARGIN_DB
    held = bridge_short_dips(excess > _OWN_HOLD_MARGIN_DB, _OWNER_BRIDGE_FRAMES)
    runs = [
        (lo, hi)
        for lo, hi in bool_runs(held)
        if any(b - a >= least for a, b in bool_runs(hot[lo:hi]))
        and not any(carries(index, lo, hi) for index in range(len(copies)))
    ]
    return _frame_spans(runs, whole_frame=True)


def _foreign_speech(
    own: np.ndarray,
    copy: _PeerCopy,
    words: list[tuple[float, float]],
    dominance_db: float,
) -> list[tuple[float, float]]:
    """The peer's voice on this lane.

    The peer's words grow through the frames where its open direct track out-levels
    this lane by the bleed margin, since ASR word spans miss the copy between words.
    """
    direct = copy.direct(own.size)
    owned = bridge_short_dips(
        (direct > _PEER_OPEN_DB) & (direct - own >= dominance_db), _OWNER_BRIDGE_FRAMES
    )
    word_index = HalfOpenIntervalIndex.build(words)
    return merge_intervals(
        [
            *words,
            *(
                run
                for run in _frame_spans(bool_runs(owned), whole_frame=False)
                if word_index.overlaps(*run)
            ),
        ]
    )


class _UnavailableGateEvidence(Exception):
    def __init__(self, plan: BleedGatePlan) -> None:
        super().__init__("gate evidence is temporarily unavailable")
        self.plan = plan


@lru_cache(maxsize=16)
def _cached_bleed_gate_plan(
    project_json: str, track_id: str, _media_revision: str, source_clock: bool, ignore_scope: bool
) -> BleedGatePlan:
    plan = _compute_bleed_gate_plan(
        EpisodeProject.model_validate_json(project_json),
        track_id,
        source_clock=source_clock,
        ignore_scope=ignore_scope,
    )
    if any(reason.startswith("unavailable_") for reason in plan.reasons):
        raise _UnavailableGateEvidence(plan)
    return plan


def build_bleed_gate_plan(
    project: EpisodeProject,
    track_id: str,
    *,
    source_clock: bool = False,
    ignore_scope: bool = False,
) -> BleedGatePlan:
    """Reuse immutable acoustic evidence until selected media, metadata, or policy changes."""
    serialized = project.model_dump_json(
        by_alias=True, include={"version", "meta", "sources", "timeline", "transcript_data"}
    )
    revision = json.dumps(
        bleed_gate_payload(project, track_id), sort_keys=True, separators=(",", ":")
    )
    try:
        return _cached_bleed_gate_plan(serialized, track_id, revision, source_clock, ignore_scope)
    except _UnavailableGateEvidence as exc:
        return exc.plan


def _compute_bleed_gate_plan(
    project: EpisodeProject,
    track_id: str,
    *,
    source_clock: bool = False,
    ignore_scope: bool = False,
) -> BleedGatePlan:
    timeline = SessionTimeline(project)
    if source_clock:
        from podcast_mcp.engines.timeline_render import resolve_clip_audio_path

        track = project.track_by_id(track_id)
        try:
            primary = track_audio_path(project, track_id).resolve()
            if track is None or any(
                resolve_clip_audio_path(project, track, span.clip).resolve() != primary
                for span in timeline.lane_clip_spans(track_id)
            ):
                return BleedGatePlan(reasons=("unsupported_source_proxy_layout",))
        except (OSError, ValueError):
            return BleedGatePlan(reasons=("unavailable_owner_source",))
    transcripts = project.selected_source_transcripts(track_id)
    if not transcripts:
        return BleedGatePlan(reasons=("missing_transcript",))
    geometry = bleed_gate_geometry(project, track_id)
    untranscribed_spans = list(geometry.untranscribed_spans)
    word_spans = [(mapped.word, list(mapped.spans)) for mapped in geometry.words]
    related = {track_id} | {word.dominant_track for word, _ in word_spans if word.dominant_track}
    if any(raw_evidence_layout_reason(project, tid) for tid in related):
        return BleedGatePlan(reasons=("unsupported_crossfade_evidence_clock",))
    candidates = [
        (mapped.word, list(mapped.spans)) for mapped in geometry.words if mapped.is_candidate
    ]
    if not candidates:
        return BleedGatePlan(reasons=("no_confirmed_bleed_words",))
    policy = AnalysisPolicy.from_defaults()
    sources: dict[Path, np.ndarray] = {}
    try:
        own = raw_timeline_samples(project, track_id, sources=sources, sample_rate=EVIDENCE_RATE)
    except (OSError, ValueError, wave.Error, CalledProcessError):
        return BleedGatePlan(reasons=("unavailable_owner_source",))
    own_levels = _levels_db(own)
    spans_by_peer: dict[str, list[tuple[float, float]]] = {}
    for word, spans in candidates:
        if word.dominant_track and word.dominant_track != track_id:
            spans_by_peer.setdefault(word.dominant_track, []).extend(
                (float(start), float(end)) for start, end in spans
            )
    seeds = [
        (float(start), float(end))
        for word, spans in word_spans
        if not word.suppressed
        for start, end in spans
    ]
    attenuation: list[tuple[float, float]] = []
    copies: list[_PeerCopy] = []
    reasons = {"untranscribed_source_protected"} if untranscribed_spans else set()
    for peer_id, peer_words in sorted(spans_by_peer.items()):
        try:
            peer = raw_timeline_samples(
                project, peer_id, sources=sources, sample_rate=EVIDENCE_RATE
            )
        except (OSError, ValueError, wave.Error, CalledProcessError):
            reasons.add("unavailable_peer_source")
            continue
        copy = _peer_copy(own_levels, own, _levels_db(peer), peer, peer_words, seeds)
        if copy is None:
            reasons.add("uncertain_foreign_ownership")
            continue
        attenuation.extend(_foreign_speech(own_levels, copy, peer_words, policy.bleed_dominance_db))
        copies.append(copy)
    attenuation = merge_intervals(attenuation)
    protected = merge_intervals(
        [
            *_owner_protection(own, seeds, attenuation),
            *(_own_voice(own_levels, own, copies) if copies else []),
            *untranscribed_spans,
        ]
    )
    attenuation = subtract_intervals(attenuation, protected)
    if not ignore_scope:
        attenuation = intersect_intervals(attenuation, _scope_intervals(project, track_id))
    attenuation = [(start, end) for start, end in attenuation if end - start > 2 * GATE_FADE_SEC]
    if source_clock and timeline.lane_clip_spans(track_id):
        placements = timeline.lane_clip_spans(track_id)
        attenuation = merge_intervals(
            (float(source_span[0]), float(source_span[1]))
            for lo, hi in attenuation
            for placement in placements
            if (source_span := clip_timeline_overlap_to_source(placement.clip, lo, hi)) is not None
        )
        protected = merge_intervals(
            (float(source_span[0]), float(source_span[1]))
            for lo, hi in protected
            for placement in placements
            if (source_span := clip_timeline_overlap_to_source(placement.clip, lo, hi)) is not None
        )
    return BleedGatePlan(
        tuple(attenuation),
        tuple(protected),
        tuple(sorted(reasons)),
        attenuation_db=policy.bleed_attenuation_db,
    )


def bleed_gate_payload(project: EpisodeProject, track_id: str) -> dict[str, Any]:
    """Gate-driving metadata and media revisions without decoding acoustic evidence."""
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path

    track = project.track_by_id(track_id)
    if track is None:
        return {}
    transcripts = project.selected_source_transcripts(track_id)
    relevant = {track_id}
    for _, transcript in transcripts:
        relevant.update(word.dominant_track for word in transcript.words if word.dominant_track)
    inputs: list[dict[str, Any]] = []
    for tid in sorted(relevant):
        lane = project.track_by_id(tid)
        if lane is None:
            continue
        clips = SessionTimeline(project).lane_clip_spans(tid)
        paths: list[Path] = []
        with suppress(OSError, ValueError):
            paths = (
                [resolve_clip_audio_path(project, lane, span.clip) for span in clips]
                if clips
                else [track_audio_path(project, tid)]
            )
        media: list[dict[str, Any]] = []
        for path in sorted(set(paths)):
            try:
                media.append({"path": str(path), "revision": file_revision(path)})
            except OSError:
                media.append({"path": str(path), "unavailable": True})
        words = project.selected_source_transcripts(tid)
        inputs.append(
            {
                "track_id": tid,
                "media": media,
                "clips": [span.clip.model_dump(mode="json") for span in clips],
                "transcribed_source_ids": [source_id for source_id, _ in words],
                "words": [
                    {
                        "source_id": source_id,
                        "start": word.start,
                        "end": word.end,
                        "suppressed": word.suppressed,
                        "status": word.audibility_status,
                        "dominant_track": word.dominant_track,
                        "locked": word.audibility_locked,
                        "ignored": word.ignored,
                    }
                    for source_id, transcript in words
                    for word in transcript.words
                ],
            }
        )
    policy = AnalysisPolicy.from_defaults()
    return {
        "revision": BLEED_GATE_REV,
        "fade_sec": GATE_FADE_SEC,
        "policy": {
            "attenuation_db": policy.bleed_attenuation_db,
            "dominance_db": policy.bleed_dominance_db,
            "evidence_rate": EVIDENCE_RATE,
            "level_frame_sec": _LEVEL_FRAME_SEC,
            "level_floor_db": LEVEL_FLOOR_DB,
            "max_path_lag_sec": _MAX_PATH_LAG_SEC,
            "null_shifts_sec": list(NULL_SHIFTS_SEC),
            "min_path_correlation": MIN_CORRELATION,
            "min_null_margin": MIN_NULL_MARGIN,
            "min_path_frames": _MIN_PATH_FRAMES,
            "contour_sec": _CONTOUR_SEC,
            "peer_open_db": _PEER_OPEN_DB,
            "copy_hold_sec": _COPY_HOLD_SEC,
            "onset_reach_sec": _ONSET_REACH_SEC,
            "own_margin_db": _OWN_MARGIN_DB,
            "own_hold_margin_db": _OWN_HOLD_MARGIN_DB,
            "min_own_sec": _MIN_OWN_SEC,
            "timbre_share": _TIMBRE_SHARE,
            "timbre_band_hz": list(_TIMBRE_BAND_HZ),
            "timbre_smooth_bins": _TIMBRE_SMOOTH_BINS,
            "likeness_frames": _LIKENESS_FRAMES,
            "owner_frame_sec": _OWNER_FRAME_SEC,
            "owner_hop_sec": _OWNER_HOP_SEC,
            "owner_floor_db": _OWNER_FLOOR_DB,
            "owner_floor_percentile": _OWNER_FLOOR_PERCENTILE,
            "owner_floor_margin_db": _OWNER_FLOOR_MARGIN_DB,
            "owner_bridge_frames": _OWNER_BRIDGE_FRAMES,
        },
        "scope": [scope.model_dump(mode="json") for scope in track.transcript_gate_scope]
        if track.transcript_gate_scope is not None
        else None,
        "inputs": inputs,
    }
