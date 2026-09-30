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

from podcast_mcp.engines.align import xcorr_lag_window
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    clip_source_to_timeline_shift,
    clip_timeline_overlap_to_source,
)
from podcast_mcp.engines.ungated_audio import (
    raw_evidence_layout_reason,
    raw_timeline_samples,
    raw_timeline_window,
)
from podcast_mcp.models import EpisodeProject, TranscriptGateScope, TranscriptWord
from podcast_mcp.util.dsp import bool_runs, bridge_short_dips, frame_rms_db_stream, linear_rms
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

BLEED_GATE_REV = 3
EVIDENCE_RATE = 8000
VERIFICATION_RATE = 48_000
GATE_FADE_SEC = 0.012
_FRAME_SEC = 0.08
_MAX_LAG_SEC = 0.025
_MIN_COPY_CORRELATION = 0.98
_PCM_UNCERTAINTY = 3 / 32768
_NULL_SHIFT_SEC = 0.32
_MIN_NULL_MARGIN = 0.15
_MAX_COPY_GAIN = 0.5
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

    @cached_property
    def _attenuation_index(self) -> HalfOpenIntervalIndex:
        return HalfOpenIntervalIndex.build(self.attenuation_spans)

    def gains_for_frames(self, first_frame: int, count: int, rate: int) -> np.ndarray:
        """Gain on the absolute clock, with transitions inside justified attenuation."""
        gains = np.ones(count, dtype=np.float32)
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
            values = np.zeros(count, dtype=np.float32)
            if width:
                values = np.maximum(
                    np.clip((lo + width - positions) / width, 0, 1),
                    np.clip((positions - (hi - width - 1)) / width, 0, 1),
                ).astype(np.float32)
            gains[selected] = np.minimum(gains[selected], values[selected])
        return gains


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
    samples: np.ndarray, seeds: list[tuple[float, float]]
) -> list[tuple[float, float]]:
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
    runs = [
        (lo * _OWNER_HOP_SEC, hi * _OWNER_HOP_SEC + _OWNER_HOP_SEC) for lo, hi in bool_runs(active)
    ]
    expanded = list(seeds)
    seed_index = HalfOpenIntervalIndex.build(seeds)
    for start, end in runs:
        if seed_index.overlaps(start, end):
            expanded.append((start, end))
    return merge_intervals(expanded)


def _verified_copy_frames(
    own: np.ndarray, peer: np.ndarray, start: float, end: float
) -> tuple[list[tuple[float, float]], int]:
    lo, hi = (
        max(0, round(start * EVIDENCE_RATE)),
        min(own.size, peer.size, round(end * EVIDENCE_RATE)),
    )
    frame = round(_FRAME_SEC * EVIDENCE_RATE)
    if hi - lo < frame:
        return [], 0
    own_window = own[lo:hi].astype(np.float64)
    peer_window = peer[lo:hi].astype(np.float64)
    corr, center = xcorr_lag_window(own_window, peer_window, round(_MAX_LAG_SEC * EVIDENCE_RATE))
    lag = int(np.argmax(np.abs(corr))) - center
    spans: list[tuple[float, float]] = []
    for first in range(lo, hi, frame):
        last = min(first + frame, hi)
        peer_first, peer_last = first - lag, last - lag
        if last - first < frame // 2 or peer_first < 0 or peer_last > peer.size:
            continue
        x = peer[peer_first:peer_last].astype(np.float64)
        y = own[first:last].astype(np.float64)
        x -= x.mean()
        y -= y.mean()
        xx, yy = float(x @ x), float(y @ y)
        if xx <= 1e-10 or yy <= 1e-10:
            continue
        xy = float(x @ y)
        correlation = abs(xy) / math.sqrt(xx * yy)
        scale = xy / xx
        residual = linear_rms(y - scale * x)
        null_correlation = 0.0
        for offset in (
            -round(_NULL_SHIFT_SEC * EVIDENCE_RATE),
            round(_NULL_SHIFT_SEC * EVIDENCE_RATE),
        ):
            null_first, null_last = peer_first + offset, peer_last + offset
            if null_first < 0 or null_last > peer.size:
                continue
            null = peer[null_first:null_last].astype(np.float64)
            null -= null.mean()
            energy = float(null @ null)
            if energy > 1e-10:
                null_correlation = max(
                    null_correlation, abs(float(null @ y)) / math.sqrt(energy * yy)
                )
        if (
            correlation >= _MIN_COPY_CORRELATION
            and correlation - null_correlation >= _MIN_NULL_MARGIN
            and abs(scale) <= _MAX_COPY_GAIN
            and residual <= _PCM_UNCERTAINTY
        ):
            spans.append((first / EVIDENCE_RATE, last / EVIDENCE_RATE))
    return merge_intervals(spans), lag


def _supported_sources(project: EpisodeProject, track_id: str) -> bool:
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path

    track = project.track_by_id(track_id)
    if track is None:
        return False
    spans = SessionTimeline(project).lane_clip_spans(track_id)
    paths = (
        [resolve_clip_audio_path(project, track, span.clip) for span in spans]
        if spans
        else [track_audio_path(project, track_id)]
    )
    for path in paths:
        with wave.open(str(path), "rb") as source:
            if (
                source.getnchannels() != 1
                or source.getsampwidth() != 2
                or source.getframerate() > VERIFICATION_RATE
            ):
                return False
    return True


def _full_band_copy(
    project: EpisodeProject, track_id: str, peer_id: str, start: float, end: float, lag: int
) -> bool:
    peer_start = start - lag / EVIDENCE_RATE
    peer_end = end - lag / EVIDENCE_RATE
    if peer_start < 0:
        return False
    own = raw_timeline_window(project, track_id, start, end, sample_rate=VERIFICATION_RATE).astype(
        np.float64
    )
    peer = raw_timeline_window(
        project, peer_id, peer_start, peer_end, sample_rate=VERIFICATION_RATE
    ).astype(np.float64)
    if peer.size != own.size:
        return False
    peer -= peer.mean()
    own -= own.mean()
    energy = float(peer @ peer)
    if energy <= 1e-10:
        return False
    scale = float(own @ peer) / energy
    return linear_rms(own - peer * scale) <= _PCM_UNCERTAINTY


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
    explicit_placements = bool(timeline.lane_clip_spans(track_id))
    word_spans: list[tuple[TranscriptWord, list[tuple[TimelineSec, TimelineSec]]]] = []
    for source_id, transcript in transcripts:
        bounds = [(SourceSec(word.start), SourceSec(word.end)) for word in transcript.words]
        mapped = (
            timeline.map_selected_source_spans(track_id, source_id, bounds)
            if explicit_placements
            else timeline.map_source_spans(track_id, bounds)
        )
        word_spans.extend(zip(transcript.words, mapped, strict=True))
    related = {track_id} | {word.dominant_track for word, _ in word_spans if word.dominant_track}
    if any(raw_evidence_layout_reason(project, tid) for tid in related):
        return BleedGatePlan(reasons=("unsupported_crossfade_evidence_clock",))
    candidates = [
        (word, spans)
        for word, spans in word_spans
        if word.suppressed
        and word.audibility_status == "bleed"
        and word.dominant_track
        and word.end > word.start
        and not word.ignored
        and not word.audibility_locked
        and spans
    ]
    if not candidates:
        return BleedGatePlan(reasons=("no_confirmed_bleed_words",))
    sources: dict[Path, np.ndarray] = {}
    try:
        if not _supported_sources(project, track_id):
            return BleedGatePlan(reasons=("unsupported_owner_evidence_format",))
        own = raw_timeline_samples(project, track_id, sources=sources, sample_rate=EVIDENCE_RATE)
    except (OSError, ValueError, wave.Error, CalledProcessError):
        return BleedGatePlan(reasons=("unavailable_owner_source",))
    seeds = [
        (float(start), float(end))
        for word, spans in word_spans
        if not word.suppressed
        for start, end in spans
    ]
    protected = _owner_protection(own, seeds)
    peers: dict[str, np.ndarray] = {}
    attenuation: list[tuple[float, float]] = []
    reasons: set[str] = set()
    for word, spans in candidates:
        peer_id = word.dominant_track
        if peer_id is None or peer_id == track_id:
            continue
        try:
            if peer_id not in peers:
                if not _supported_sources(project, peer_id):
                    reasons.add("unsupported_peer_evidence_format")
                    continue
                peers[peer_id] = raw_timeline_samples(
                    project, peer_id, sources=sources, sample_rate=EVIDENCE_RATE
                )
        except (OSError, ValueError, wave.Error, CalledProcessError):
            reasons.add("unavailable_peer_source")
            continue
        for start, end in spans:
            verified, lag = _verified_copy_frames(own, peers[peer_id], float(start), float(end))
            try:
                verified = [
                    (lo, hi)
                    for lo, hi in verified
                    if _full_band_copy(project, track_id, peer_id, lo, hi, lag)
                ]
            except (OSError, ValueError, CalledProcessError):
                reasons.add("unavailable_full_band_evidence")
                continue
            if not verified:
                reasons.add("uncertain_foreign_ownership")
            attenuation.extend(verified)
    attenuation = subtract_intervals(merge_intervals(attenuation), merge_intervals(protected))
    if not ignore_scope:
        attenuation = intersect_intervals(attenuation, _scope_intervals(project, track_id))
    attenuation = [(start, end) for start, end in attenuation if end - start > 2 * GATE_FADE_SEC]
    if source_clock and explicit_placements:
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
    return BleedGatePlan(tuple(attenuation), tuple(protected), tuple(sorted(reasons)))


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
    return {
        "revision": BLEED_GATE_REV,
        "fade_sec": GATE_FADE_SEC,
        "policy": {
            "evidence_rate": EVIDENCE_RATE,
            "verification_rate": VERIFICATION_RATE,
            "frame_sec": _FRAME_SEC,
            "max_lag_sec": _MAX_LAG_SEC,
            "min_copy_correlation": _MIN_COPY_CORRELATION,
            "max_residual": _PCM_UNCERTAINTY,
            "null_shift_sec": _NULL_SHIFT_SEC,
            "min_null_margin": _MIN_NULL_MARGIN,
            "max_copy_gain": _MAX_COPY_GAIN,
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
