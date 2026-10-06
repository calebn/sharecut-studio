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

from podcast_mcp.engines.audio_audit import AnalysisPolicy, BleedHandling, BleedReduction
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
from podcast_mcp.util.tracks import dialogue_track_ids, track_audio_path

BLEED_GATE_REV = 9
EVIDENCE_RATE = 8000
# Gain ramps inside each reduced span, after a hold at full level around the lane's
# own speech. On the lab tape (#945) the bed just outside Caleb's reduced spans reads
# -45 dBFS with no hold and falls to his mic's -57 dBFS bed with 20 ms before and
# 40 ms after own speech, where it stays out to 80/150 ms: his onsets and tails
# reach that far past the protection. The hold doubles that (40 ms before, 80 ms
# after) for plosive bursts (#978) and slow releases, and keeps the copy at full
# level for 10 s of Audra's 280 s of speech, half what 80/150 ms keeps. The 20 ms
# ramp is the editor's recommended join fade: long enough not to click, short
# enough to keep the copy out.
GATE_FADE_SEC = 0.02
_ONSET_HOLD_SEC = 0.04
_TAIL_HOLD_SEC = 0.08
_LEVEL_FRAME_SEC = 0.1
# ``auto`` mutes a lane only where the bed just outside the peers' copies (within
# _EDGE_FLOOR_SEC, away from its own speech) is digital silence, which the evidence
# levels read at their -90 dB floor: a call app's gate holds the lane shut there,
# so a mute cannot pump. Any bed above it is attenuated instead, so it stays steady.
# On the lab tape Caleb's edges are silent 46% of the time and otherwise carry room
# tone and Audra's tails at -71 to -80 dBFS: -56 dBFS power mean, so attenuate.
_GATED_FLOOR_DB = LEVEL_FLOOR_DB
_EDGE_FLOOR_SEC = 0.5
_MAX_PATH_LAG_SEC = 0.3
_MIN_PATH_FRAMES = 3000
_CONTOUR_SEC = 0.5
_PEER_OPEN_DB = -60.0
_COPY_HOLD_SEC = 0.05
_ONSET_REACH_SEC = 0.2
_OWN_MARGIN_DB = 4.0
_OWN_HOLD_MARGIN_DB = 2.0
_MIN_OWN_SEC = 0.05
_LIKENESS_PERCENTILE = 40
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
    reduction: BleedReduction = "mute"
    attenuation_db: float = AnalysisPolicy.bleed_attenuation_db
    floor_db: float | None = None
    """The lane's power-mean level just outside the peers' copies; ``auto`` resolves from it."""

    @property
    def floor_gain(self) -> float:
        return 0.0 if self.reduction == "mute" else 10 ** (-self.attenuation_db / 20)

    @cached_property
    def _attenuation_index(self) -> HalfOpenIntervalIndex:
        return HalfOpenIntervalIndex.build(self.attenuation_spans)

    def gains_for_frames(self, first_frame: int, count: int, rate: int) -> np.ndarray:
        """Gain on the absolute clock, with transitions inside justified attenuation."""
        gains = np.ones(count, dtype=np.float32)
        floor = self.floor_gain
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

    ``spans`` is the peer's speech on its own track's clock; the copy here leads it
    by the lag. The coupling is the median lane-to-direct level over the louder half
    of the peer's open frames, away from this lane's own words, so the lane's noise
    floor and any overlapping own speech do not move it. On the lab tape it is about
    -20 dB for Audra on Caleb's mic. The likeness is the 40th percentile of the
    fine-spectrum match on frames at that level. The room and call software blur and
    spread it on the lab (0.35; median 0.41); a copy that keeps its timbre sits in a
    narrow band near 1.
    """
    lag = _path_lag(own, peer, spans)
    if lag is None:
        return None
    reach = _PeerCopy(peer, peer_samples, lag).reach(own.size)
    lead = lag * _OWNER_HOP_SEC
    frames = (
        _hop_mask(own.size, [(start - lead, end - lead) for start, end in spans])
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
    likeness = (
        float(np.percentile(copy.similarity(own_samples, sample), _LIKENESS_PERCENTILE))
        if sample.size
        else 1.0
    )
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
    not the lane's speaker, when the median fine-spectrum match of its loud frames
    reaches the copy's likeness. Judging only the loud frames keeps the copy that a
    held run reaches into from outvoting the lane's own sound.
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

    hot = excess > _OWN_MARGIN_DB

    def carries(index: int, lo: int, hi: int) -> bool:
        heard = np.flatnonzero(audible[index][lo:hi] & hot[lo:hi]) + lo
        if heard.size == 0:
            return False
        copy = copies[index]
        return float(np.median(copy.similarity(own_samples, heard))) >= (copy.likeness)

    least = round(_MIN_OWN_SEC / _OWNER_HOP_SEC)
    held = bridge_short_dips(excess > _OWN_HOLD_MARGIN_DB, _OWNER_BRIDGE_FRAMES)
    runs = [
        (lo, hi)
        for lo, hi in bool_runs(held)
        if any(b - a >= least for a, b in bool_runs(hot[lo:hi]))
        and not any(carries(index, lo, hi) for index in range(len(copies)))
    ]
    return _frame_spans(runs, whole_frame=True)


def _foreign_speech(size: int, copies: list[_PeerCopy]) -> list[tuple[float, float]]:
    """Every frame a verified peer's copy can reach on this lane.

    Found from the peers' own tracks, not from this lane's transcript, so a copy
    with no bleed word on this lane is covered too. The lane's own speech is
    protected from it afterwards.
    """
    reached = np.zeros(size, dtype=bool)
    for copy in copies:
        reached |= copy.reach(size) > _PEER_OPEN_DB
    return _frame_spans(
        bool_runs(bridge_short_dips(reached, _OWNER_BRIDGE_FRAMES)), whole_frame=True
    )


def _edge_floor_db(
    own: np.ndarray, foreign: list[tuple[float, float]], kept: list[tuple[float, float]]
) -> float | None:
    """This lane's power-mean level just outside the peers' copies, away from its own speech.

    That is the bed a mute would make vanish and return at each copy's edge: digital
    silence (read at the level floor) on a call app's gated track, room tone and the
    copy's tails on an open mic. None when no copy has such an edge.
    """
    edges = (
        _hop_mask(own.size, foreign, _EDGE_FLOOR_SEC)
        & ~_hop_mask(own.size, foreign)
        & ~_hop_mask(own.size, kept)
    )
    if not edges.any():
        return None
    return round(10 * math.log10(float(np.mean(10 ** (own[edges] / 10)))), 1)


def _reduction(handling: BleedHandling, floor_db: float | None) -> BleedReduction:
    if handling != "auto":
        return handling
    return "attenuate" if floor_db is not None and floor_db > _GATED_FLOOR_DB else "mute"


def _peer_ids(project: EpisodeProject, track_id: str) -> list[str]:
    return [
        tid
        for tid in dialogue_track_ids(project)
        if tid != track_id and (track := project.track_by_id(tid)) is not None and track.media
    ]


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
    peer_ids = _peer_ids(project, track_id)
    if not peer_ids:
        return BleedGatePlan(reasons=("no_peer_tracks",))
    if any(raw_evidence_layout_reason(project, tid) for tid in [track_id, *peer_ids]):
        return BleedGatePlan(reasons=("unsupported_crossfade_evidence_clock",))
    policy = AnalysisPolicy.from_defaults()
    sources: dict[Path, np.ndarray] = {}
    try:
        own = raw_timeline_samples(project, track_id, sources=sources, sample_rate=EVIDENCE_RATE)
    except (OSError, ValueError, wave.Error, CalledProcessError):
        return BleedGatePlan(reasons=("unavailable_owner_source",))
    own_levels = _levels_db(own)
    seeds = [
        (float(start), float(end))
        for mapped in geometry.words
        if not mapped.word.suppressed
        for start, end in mapped.spans
    ]
    copies: list[_PeerCopy] = []
    reasons = {"untranscribed_source_protected"} if untranscribed_spans else set()
    for peer_id in peer_ids:
        try:
            peer = raw_timeline_samples(
                project, peer_id, sources=sources, sample_rate=EVIDENCE_RATE
            )
        except (OSError, ValueError, wave.Error, CalledProcessError):
            reasons.add("unavailable_peer_source")
            continue
        levels = _levels_db(peer)
        speech = _frame_spans(bool_runs(levels > _PEER_OPEN_DB), whole_frame=True)
        copy = _peer_copy(own_levels, own, levels, peer, subtract_intervals(speech, seeds), seeds)
        if copy is None:
            reasons.add("uncertain_foreign_ownership")
            continue
        copies.append(copy)
    foreign = _foreign_speech(own_levels.size, copies)
    protected = merge_intervals(
        [
            *_owner_protection(own, seeds, foreign),
            *(_own_voice(own_levels, own, copies) if copies else []),
            *untranscribed_spans,
        ]
    )
    kept = merge_intervals(
        (start - _ONSET_HOLD_SEC, end + _TAIL_HOLD_SEC) for start, end in protected
    )
    attenuation = subtract_intervals(foreign, kept)
    floor_db = _edge_floor_db(own_levels, foreign, kept)
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
        reduction=_reduction(policy.bleed_handling, floor_db),
        attenuation_db=policy.bleed_attenuation_db,
        floor_db=floor_db,
    )


def bleed_gate_payload(project: EpisodeProject, track_id: str) -> dict[str, Any]:
    """Gate-driving metadata and media revisions without decoding acoustic evidence."""
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path

    track = project.track_by_id(track_id)
    if track is None:
        return {}
    relevant = {track_id, *_peer_ids(project, track_id)}
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
            "handling": policy.bleed_handling,
            "attenuation_db": policy.bleed_attenuation_db,
            "gated_floor_db": _GATED_FLOOR_DB,
            "edge_floor_sec": _EDGE_FLOOR_SEC,
            "onset_hold_sec": _ONSET_HOLD_SEC,
            "tail_hold_sec": _TAIL_HOLD_SEC,
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
            "likeness_percentile": _LIKENESS_PERCENTILE,
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
