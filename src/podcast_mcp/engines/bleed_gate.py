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

BLEED_GATE_REV = 7
EVIDENCE_RATE = 8000
GATE_FADE_SEC = 0.012
_LEVEL_FRAME_SEC = 0.1
_LEVEL_FLOOR_DB = -90.0
_MAX_PATH_LAG_SEC = 0.3
_NULL_SHIFTS_SEC = (-2.0, -1.0, 1.0, 2.0)
_MIN_PATH_CORRELATION = 0.4
_MIN_NULL_MARGIN = 0.15
_MIN_PATH_FRAMES = 50
_PEER_OPEN_DB = -60.0
_MIN_OWN_OVERLAP_SEC = 0.1
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
    frame, hop = round(_LEVEL_FRAME_SEC * EVIDENCE_RATE), round(_OWNER_HOP_SEC * EVIDENCE_RATE)
    levels = frame_rms_db_stream(
        (samples[first : first + EVIDENCE_RATE] for first in range(0, samples.size, EVIDENCE_RATE)),
        frame,
        hop,
    )
    return np.maximum(levels, _LEVEL_FLOOR_DB)


def _hop_mask(size: int, spans: list[tuple[float, float]], pad_sec: float = 0.0) -> np.ndarray:
    mask = np.zeros(size, dtype=bool)
    for start, end in spans:
        lo = max(0, math.floor((start - pad_sec) / _OWNER_HOP_SEC))
        mask[lo : max(lo, math.ceil((end + pad_sec) / _OWNER_HOP_SEC))] = True
    return mask


def _path_lag(own: np.ndarray, peer: np.ndarray, spans: list[tuple[float, float]]) -> int | None:
    """Hops by which the peer's own track trails its copy here, if levels prove a copy.

    Zoom delivers a remote speaker's track well after the same voice reaches a mic in
    the room (about 140 ms on the lab tape), and the room colours the copy, so the
    copy is found in the level envelope at the best lag, against shifted nulls.
    """
    frames = np.flatnonzero(_hop_mask(own.size, spans, _MAX_PATH_LAG_SEC))
    reach = round(_MAX_PATH_LAG_SEC / _OWNER_HOP_SEC)

    def correlation(shift: int) -> float | None:
        usable = frames[(frames + shift >= 0) & (frames + shift < peer.size)]
        if usable.size < _MIN_PATH_FRAMES:
            return None
        x, y = own[usable], peer[usable + shift]
        if x.std() == 0 or y.std() == 0:
            return 0.0
        return float(np.corrcoef(x, y)[0, 1])

    scored = [
        (value, lag) for lag in range(-reach, reach + 1) if (value := correlation(lag)) is not None
    ]
    if not scored:
        return None
    best, lag = max(scored)
    nulls = [
        value
        for shift in _NULL_SHIFTS_SEC
        if (value := correlation(lag + round(shift / _OWNER_HOP_SEC))) is not None
    ]
    if not nulls or best < _MIN_PATH_CORRELATION or best - max(nulls) < _MIN_NULL_MARGIN:
        return None
    return lag


def _frame_spans(runs: list[tuple[int, int]], *, whole_frame: bool) -> list[tuple[float, float]]:
    """Seconds read by any frame of each run, or only the seconds every frame read covers."""
    lead, tail = (
        (0.0, _LEVEL_FRAME_SEC)
        if whole_frame
        else (_LEVEL_FRAME_SEC - _OWNER_HOP_SEC, _OWNER_HOP_SEC)
    )
    spans = [(lo * _OWNER_HOP_SEC + lead, (hi - 1) * _OWNER_HOP_SEC + tail) for lo, hi in runs]
    return [(start, end) for start, end in spans if end > start]


def _foreign_speech(
    own: np.ndarray,
    peer: np.ndarray,
    lag: int,
    words: list[tuple[float, float]],
    dominance_db: float,
) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    """The peer's voice on this lane, and the lane's own voice overlapping it.

    The peer's words grow through the frames where its open direct track out-levels
    this lane by the bleed margin, since ASR word spans miss the copy between words.
    Inside that, a syllable or more louder than the open direct track is this lane's own
    speaker; shorter blips are level noise in the copy (the lab's confirmed Audra-only
    passages have 28 of 29 under 100 ms). A direct track still gated shut is no evidence
    either way.
    """
    direct = np.full(own.size, _LEVEL_FLOOR_DB)
    lo, hi = max(0, -lag), min(own.size, peer.size - lag)
    direct[lo:hi] = peer[lo + lag : hi + lag]
    opened = direct > _PEER_OPEN_DB
    owned = bridge_short_dips(opened & (direct - own >= dominance_db), _OWNER_BRIDGE_FRAMES)
    word_index = HalfOpenIntervalIndex.build(words)
    foreign = merge_intervals(
        [
            *words,
            *(
                run
                for run in _frame_spans(bool_runs(owned), whole_frame=False)
                if word_index.overlaps(*run)
            ),
        ]
    )
    louder = opened & (own - direct >= dominance_db) & _hop_mask(own.size, foreign)
    syllable = round(_MIN_OWN_OVERLAP_SEC / _OWNER_HOP_SEC)
    runs = [(lo, hi) for lo, hi in bool_runs(louder) if hi - lo >= syllable]
    return foreign, _frame_spans(runs, whole_frame=True)


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
    attenuation: list[tuple[float, float]] = []
    overlaps: list[tuple[float, float]] = []
    reasons = {"untranscribed_source_protected"} if untranscribed_spans else set()
    for peer_id, peer_words in sorted(spans_by_peer.items()):
        try:
            peer = _levels_db(
                raw_timeline_samples(project, peer_id, sources=sources, sample_rate=EVIDENCE_RATE)
            )
        except (OSError, ValueError, wave.Error, CalledProcessError):
            reasons.add("unavailable_peer_source")
            continue
        lag = _path_lag(own_levels, peer, peer_words)
        if lag is None:
            reasons.add("uncertain_foreign_ownership")
            continue
        foreign, overlap = _foreign_speech(
            own_levels, peer, lag, peer_words, policy.bleed_dominance_db
        )
        attenuation.extend(foreign)
        overlaps.extend(overlap)
    seeds = [
        (float(start), float(end))
        for word, spans in word_spans
        if not word.suppressed
        for start, end in spans
    ]
    attenuation = merge_intervals(attenuation)
    protected = merge_intervals(
        [*_owner_protection(own, seeds, attenuation), *overlaps, *untranscribed_spans]
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
            "level_floor_db": _LEVEL_FLOOR_DB,
            "max_path_lag_sec": _MAX_PATH_LAG_SEC,
            "null_shifts_sec": list(_NULL_SHIFTS_SEC),
            "min_path_correlation": _MIN_PATH_CORRELATION,
            "min_null_margin": _MIN_NULL_MARGIN,
            "min_path_frames": _MIN_PATH_FRAMES,
            "peer_open_db": _PEER_OPEN_DB,
            "min_own_overlap_sec": _MIN_OWN_OVERLAP_SEC,
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
