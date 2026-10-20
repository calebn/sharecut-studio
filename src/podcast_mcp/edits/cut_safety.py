from __future__ import annotations

import logging
import math
import subprocess
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from functools import partial
from itertools import pairwise
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, TypeAlias

import numpy as np

from podcast_mcp.config import EffectiveConfig
from podcast_mcp.edits import cut_speech, join_continuity, speech_energy_guard
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.breath_detect import (
    _LEVEL_CONTEXT_SEC,
    _audio_reader,
    _breath_cfg,
    _ClearEdge,
    _CompleteEdgeBreath,
    _edge_evidence,
    _kept_spans,
    _mostly_breath,
    _read_evidence,
    _UncertainEdge,
)
from podcast_mcp.edits.cut_policy import (
    CUT_EDGE_CHECKS,
    SAFETY_LABELS,
    BreathEdgeAction,
    CutJoin,
    CutMode,
    action_for_safety_observation,
    edit_time_behavior,
)
from podcast_mcp.edits.cut_speech import CutSpeechConfirmation, SourceExtent
from podcast_mcp.edits.filler_pacing import pause_trim_is_imperceptible
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.edits.join_continuity import JoinContinuityConfig, JoinContinuityReport
from podcast_mcp.edits.mute_regions import IgnoredWordRegions
from podcast_mcp.edits.pause_floor import retained_pause_floor_sec
from podcast_mcp.edits.ripple import RippleRemoval, TrimPlan, ripple_track_ids
from podcast_mcp.edits.session_air import GeometricPause, MeasuredPause
from podcast_mcp.edits.speech_energy_guard import SpeechEnergyGuardResult
from podcast_mcp.edits.tighten_reasons import (
    is_acoustic_filler_reason,
)
from podcast_mcp.edits.voiced_runs import (
    FRAME_SEC,
    audible_runs,
    run_straddling,
    voiced_runs,
    voiced_sec_inside,
)
from podcast_mcp.edits.word_onset import edge_decays_into_valley, next_kept_word
from podcast_mcp.engines.audio import GainRamp, MuteSampleEnvelope, PlacedSource
from podcast_mcp.engines.audio_audit import TrackRmsCacheSet
from podcast_mcp.engines.level_profile import LEVEL_FRAME_SEC, LevelProfile, level_profile
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    TimelineClipSpan,
    clip_plays_lane,
    clip_timeline_overlap_to_source,
    origin_track_id_for_clip,
)
from podcast_mcp.models import (
    AppliedEditRecord,
    Clip,
    CutIntent,
    CutSpeech,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    TranscriptWord,
)
from podcast_mcp.models.episode import ExactRangeTarget
from podcast_mcp.util.batch_scope import scoped, scoped_by_file
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.intervals import merge_intervals, subtract_intervals
from podcast_mcp.util.media_identity import same_recording
from podcast_mcp.util.timebase import SourceSec, TimelineSec
from podcast_mcp.util.tracks import dialogue_track_ids

if TYPE_CHECKING:
    from podcast_mcp.edits.timeline_ops import LaneUnavailable, PauseEdgeFade, RoomTonePad

log = logging.getLogger(__name__)
_SOURCE_GEOMETRY_TOLERANCE_SEC = 1e-6


class DuplicateSourceOccurrence(ValueError):
    """A completed edit reused or replayed one source occurrence."""


def protect_cut_breaths(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    defaults: EffectiveConfig,
    sample_rate: int = 16000,
    audio_cache: TrackAudioCache | None = None,
    word_index: CutWordIndex | None = None,
    strict: bool = True,
    held: bool = False,
) -> tuple[float, float] | None:
    if not (
        math.isfinite(start) and math.isfinite(end) and (start < end or (held and start == end))
    ):
        return None
    cfg = _breath_cfg(defaults)
    if not cfg["enabled"]:
        return start, end
    no_evidence = None if strict else (start, end)
    read = _audio_reader(project, track_id, sample_rate, audio_cache)
    if read is None:
        return no_evidence
    context_start = max(
        0.0, math.floor((start - _LEVEL_CONTEXT_SEC) / LEVEL_FRAME_SEC + 1e-9) * LEVEL_FRAME_SEC
    )
    before_end = math.floor(start / LEVEL_FRAME_SEC + 1e-9) * LEVEL_FRAME_SEC
    after_start = math.ceil(end / LEVEL_FRAME_SEC - 1e-9) * LEVEL_FRAME_SEC
    before = _read_evidence(read, context_start, before_end - context_start)
    after = _read_evidence(read, after_start, _LEVEL_CONTEXT_SEC)
    context = np.concatenate([before, after])
    if not np.all(np.isfinite(context)):
        return no_evidence
    profile = level_profile(context, sample_rate)
    if profile is None:
        return no_evidence
    words = word_index or CutWordIndex.build(project, track_id)
    windows = []
    for edge in (start, end):
        origin = max(
            0.0,
            math.floor((edge - _LEVEL_CONTEXT_SEC) / LEVEL_FRAME_SEC + 1e-9) * LEVEL_FRAME_SEC,
        )
        samples = _read_evidence(read, origin, edge + _LEVEL_CONTEXT_SEC - origin)
        windows.append((origin, samples))

    def inspect(
        edge: float, window: tuple[float, np.ndarray], bounds: tuple[float, float]
    ) -> _ClearEdge | _CompleteEdgeBreath | _UncertainEdge:
        origin, samples = window
        keep_out = _kept_spans(words, origin, origin + samples.size / sample_rate, *bounds)
        return _edge_evidence(
            samples,
            origin,
            edge,
            sample_rate=sample_rate,
            profile=profile,
            cfg=cfg,
            keep_out=keep_out,
            defaults=defaults,
        )

    evidence = [
        inspect(edge, window, (start, end))
        for edge, window in zip((start, end), windows, strict=True)
    ]
    if strict and any(isinstance(item, _UncertainEdge) for item in evidence):
        return None
    if held and any(isinstance(item, _CompleteEdgeBreath) for item in evidence):
        return None
    new_start = evidence[0].span.end if isinstance(evidence[0], _CompleteEdgeBreath) else start
    new_end = evidence[1].span.start if isinstance(evidence[1], _CompleteEdgeBreath) else end
    if new_start > new_end or (new_start == new_end and not held):
        return None
    if strict:
        for edge, window in zip((start, end), windows, strict=True):
            if isinstance(inspect(edge, window, (new_start, new_end)), _UncertainEdge):
                return None
    elif _mostly_breath(
        new_start,
        new_end,
        read=read,
        words=words,
        profile=profile,
        cfg=cfg,
        sample_rate=sample_rate,
        defaults=defaults,
    ):
        return None
    return new_start, new_end


def protect_cut_edges(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    join: CutJoin,
    defaults: EffectiveConfig,
    sample_rate: int = 16000,
    audio_cache: TrackAudioCache | None = None,
    word_index: CutWordIndex | None = None,
) -> tuple[float, float] | None:
    action = CUT_EDGE_CHECKS[join].breaths
    if action is BreathEdgeAction.IGNORE:
        return start, end
    return protect_cut_breaths(
        project,
        track_id,
        start,
        end,
        defaults=defaults,
        sample_rate=sample_rate,
        audio_cache=audio_cache,
        word_index=word_index,
        strict=action is BreathEdgeAction.PROTECT,
    )


def pending_pad_source_spans(
    project: EpisodeProject, besides: EditDecision
) -> dict[str, list[tuple[float, float]]]:
    timeline = SessionTimeline(project)
    spans: dict[str, list[tuple[float, float]]] = {}
    for other in project.edit_decisions:
        if (
            other.id == besides.id
            or other.applied
            or other.exact_range is not None
            or other.type not in (EditDecisionType.REMOVE, EditDecisionType.MUTE)
            or not timeline.map_source_span(
                other.track_id, SourceSec(other.start), SourceSec(other.end)
            )
        ):
            continue
        spans.setdefault(other.track_id, []).append((other.start, other.end))
    return spans


@dataclass(frozen=True)
class CutScopeHold:
    edit_id: str
    peers: tuple[str, ...]
    reason: Literal[
        "peer_speech",
        "source_geometry",
        "stored_track_pause",
        "speaker_bleed",
        "scope_unavailable",
        "pause_not_shorter",
        "pause_imperceptible",
        "media_extent_unavailable",
        "operation_scope",
        "pause_air",
        "pause_join",
        "acoustic_edge",
    ] = "peer_speech"
    unavailable_lanes: tuple[LaneUnavailable, ...] = ()
    detail: str | None = None


def source_remove_lanes(
    project: EpisodeProject,
    timeline: SessionTimeline,
    edit: EditDecision,
    start: TimelineSec,
    end: TimelineSec,
) -> frozenset[str]:
    if edit.source_timeline_span is not None:
        source_ids = project.equivalent_source_ids(edit.track_id, edit.source_id)
        selected = frozenset(
            clip.track_id
            for clip in project.clips
            if clip.source_id in source_ids
            and clip_plays_lane(project, clip, edit.track_id)
            and min(float(end), clip.timeline_end) > max(float(start), clip.timeline_start) + 1e-9
        )
        if selected:
            return selected
    return timeline.origin_placement_lanes(edit.track_id, start, end)


def inspect_source_remove_placement(
    project: EpisodeProject, edit: EditDecision, *, check_witness: bool = True
) -> tuple[TimelineSec, TimelineSec] | CutScopeHold:
    if (
        edit.type not in (EditDecisionType.REMOVE, EditDecisionType.MUTE)
        or edit.exact_range is not None
        or edit.timebase != "source"
    ):
        raise CodedValueError(
            "ordinary source remove or mute required. Use a remove or mute edit.",
            code="edit_type_invalid",
        )
    if not (math.isfinite(edit.start) and math.isfinite(edit.end) and 0 <= edit.start < edit.end):
        return CutScopeHold(edit.id, (), "source_geometry")
    pause = edit.type == EditDecisionType.REMOVE and (edit.reason or "").startswith("pause:")
    if pause and edit.scope == "track":
        return CutScopeHold(edit.id, (), "stored_track_pause")
    timeline = SessionTimeline(project)
    span: tuple[TimelineSec, TimelineSec] | None
    if edit.source_timeline_span is not None:
        lane_clips = [c for c in project.clips if clip_plays_lane(project, c, edit.track_id)]
        if lane_clips:
            spans = timeline.map_placements_source_span(
                edit.track_id,
                project.equivalent_source_ids(edit.track_id, edit.source_id),
                SourceSec(edit.start),
                SourceSec(edit.end),
            )
        elif None in project.equivalent_source_ids(edit.track_id, edit.source_id):
            spans = timeline.map_source_span(
                edit.track_id, SourceSec(edit.start), SourceSec(edit.end)
            )
        else:
            spans = []
        expected = edit.source_timeline_span
        if (
            len(spans) != 1
            or abs(float(spans[0][1] - spans[0][0]) - (edit.end - edit.start)) > 1e-6
            or (
                check_witness
                and expected is not None
                and (
                    abs(float(spans[0][0]) - expected.start) > 1e-6
                    or abs(float(spans[0][1]) - expected.end) > 1e-6
                )
            )
        ):
            return CutScopeHold(edit.id, (), "source_geometry")
        span = (
            (TimelineSec(expected.start), TimelineSec(expected.end))
            if check_witness and expected is not None
            else (spans[0][0], spans[0][1])
        )
        if _witnessed_source_span_has_unsafe_overlap(project, edit, *span):
            return CutScopeHold(edit.id, (), "source_geometry")
    else:
        if edit.source_id is not None:
            return CutScopeHold(edit.id, (), "source_geometry")
        span = timeline.exact_source_span(edit.track_id, SourceSec(edit.start), SourceSec(edit.end))
    if span is None:
        track = project.track_by_id(edit.track_id)
        if (
            track
            and track.media
            and not track.timeline_empty
            and not any(
                c.track_id == edit.track_id or origin_track_id_for_clip(project, c) == edit.track_id
                for c in project.clips
            )
            and (track.media.duration_sec is None or not math.isfinite(track.media.duration_sec))
        ):
            return CutScopeHold(edit.id, (), "media_extent_unavailable")
        return CutScopeHold(edit.id, (), "source_geometry")
    lanes = source_remove_lanes(project, timeline, edit, *span)
    allowed = (
        {edit.track_id}
        if edit.scope == "track" or edit.type == EditDecisionType.MUTE
        else set(ripple_track_ids(project, [edit.track_id]))
    )
    if not lanes or not lanes <= allowed:
        return CutScopeHold(
            edit.id, (), "source_geometry" if edit.scope == "track" else "operation_scope"
        )
    return span


def _witnessed_source_span_has_unsafe_overlap(
    project: EpisodeProject,
    edit: EditDecision,
    start: TimelineSec,
    end: TimelineSec,
) -> bool:
    source_ids = project.equivalent_source_ids(edit.track_id, edit.source_id)
    lo_window, hi_window = float(start), float(end)
    selected_pieces = []
    for clip in project.clips:
        lo = max(lo_window, clip.timeline_start)
        hi = min(hi_window, clip.timeline_end)
        if (
            hi <= lo + _SOURCE_GEOMETRY_TOLERANCE_SEC
            or clip.source_id not in source_ids
            or not clip_plays_lane(project, clip, edit.track_id)
        ):
            continue
        selected_pieces.append((clip, lo, hi))

    selected_lanes = {clip.track_id for clip, _, _ in selected_pieces}
    protected_lanes = selected_lanes | {edit.track_id}
    for clip in project.clips:
        if clip.track_id not in protected_lanes:
            continue
        lo = max(lo_window, clip.timeline_start)
        hi = min(hi_window, clip.timeline_end)
        if hi <= lo + _SOURCE_GEOMETRY_TOLERANCE_SEC:
            continue
        if clip.source_id not in source_ids or not clip_plays_lane(project, clip, edit.track_id):
            return True
        expected_lo = edit.start + (lo - lo_window)
        expected_hi = edit.start + (hi - lo_window)
        actual = clip_timeline_overlap_to_source(clip, lo, hi)
        if actual is None:
            return True
        actual_lo, actual_hi = actual
        if (
            abs(actual_lo - expected_lo) > _SOURCE_GEOMETRY_TOLERANCE_SEC
            or abs(actual_hi - expected_hi) > _SOURCE_GEOMETRY_TOLERANCE_SEC
        ):
            return True

    if not selected_pieces:
        return False
    boundaries = sorted(
        {
            lo_window,
            hi_window,
            *(lo for _, lo, _ in selected_pieces),
            *(hi for _, _, hi in selected_pieces),
        }
    )
    for left, right in pairwise(boundaries):
        if right <= left + _SOURCE_GEOMETRY_TOLERANCE_SEC:
            continue
        covering = [
            clip
            for clip, lo, hi in selected_pieces
            if lo <= left + _SOURCE_GEOMETRY_TOLERANCE_SEC
            and hi >= right - _SOURCE_GEOMETRY_TOLERANCE_SEC
        ]
        if len(covering) != 1:
            return True
    return False


@dataclass(frozen=True)
class CutRejected:
    """A candidate analysis refused, counted as ``skip`` in the proposal's skip counts."""

    skip: str
    unavailable_lanes: tuple[LaneUnavailable, ...] = ()


@dataclass(frozen=True)
class OriginalQuietSupport:
    pieces: tuple[TimelineClipSpan, ...]

    @property
    def seconds(self) -> float:
        return sum(
            hi - lo
            for lo, hi in merge_intervals(
                (float(piece.source_start), float(piece.source_end)) for piece in self.pieces
            )
        )


def _inside_known_pad(clip: Clip, pads: Sequence[tuple[float, float]]) -> bool:
    """Whether a clip is a tile cut from a recorded pad's samples, not original audio.

    A copy of samples is not the audio it copies, so the original clip that those samples
    came from stays original quiet.
    """
    return any(
        lo - _SOURCE_GEOMETRY_TOLERANCE_SEC <= clip.source_start
        and clip.source_end <= hi + _SOURCE_GEOMETRY_TOLERANCE_SEC
        for lo, hi in pads
    )


def original_pause_support(
    project: EpisodeProject,
    track_id: str,
    words: tuple[TranscriptWord, TranscriptWord],
    observation: GeometricPause | MeasuredPause,
) -> OriginalQuietSupport | CutRejected:
    from podcast_mcp.edits.clips_ops import uses_crossfade_join
    from podcast_mcp.edits.ripple import ripple_track_ids
    from podcast_mcp.edits.room_tone import room_tone_source_id
    from podcast_mcp.edits.track_media import full_span_clip
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
    from podcast_mcp.util.coded_error import CodedError
    from podcast_mcp.util.tracks import recording_audio_path
    from podcast_mcp.util.workspace_paths import resolve_under_workspace

    timeline = SessionTimeline(project)
    before, after = words
    before_span = timeline.exact_source_span(
        track_id, SourceSec(before.start), SourceSec(before.end)
    )
    after_span = timeline.exact_source_span(track_id, SourceSec(after.start), SourceSec(after.end))
    if before_span is None or after_span is None or before_span[1] > after_span[0]:
        return CutRejected("source_geometry")
    origin = project.track_by_id(track_id)
    if origin is None or origin.media is None:
        return CutRejected("source_geometry")
    try:
        media = resolve_under_workspace(project, origin.media.path).resolve()
    except (CodedError, OSError, ValueError):
        return CutRejected("source_geometry")
    images = []
    for track in project.tracks:
        lane = timeline.lane_clip_spans(track.id)
        if not lane and (
            not track.timeline_empty
            and track.media is not None
            and track.media.duration_sec is not None
            and math.isfinite(track.media.duration_sec)
        ):
            clip = full_span_clip(track.id, track.media.duration_sec)
            lane = [
                TimelineClipSpan(
                    TimelineSec(0),
                    TimelineSec(track.media.duration_sec),
                    SourceSec(0),
                    SourceSec(track.media.duration_sec),
                    clip,
                )
            ]
        images.extend(lane)
    same_media = []
    for image in images:
        clip = image.clip
        clip_track = project.track_by_id(clip.track_id)
        if clip_track is None:
            continue
        try:
            if same_recording(resolve_clip_audio_path(project, clip_track, clip), media):
                same_media.append(image)
        except (CodedError, OSError, ValueError):
            continue
    for track in project.tracks:
        bed_source = project.source_by_id(room_tone_source_id(track.id))
        if track.room_tone is not None and bed_source is not None:
            try:
                if same_recording(resolve_under_workspace(project, bed_source.path), media):
                    return OriginalQuietSupport(())
            except (CodedError, OSError, ValueError):
                continue
    known_pads: list[tuple[float, float]] = []
    for record in project.editorial.edit_log:
        gap = record.params.get("replace_gap_sec")
        pad_purpose = record.operation in {"fill_with_room_tone", "insert_room_tone_pad"} or (
            isinstance(gap, (int, float))
            and not isinstance(gap, bool)
            and math.isfinite(gap)
            and gap > 0
            and record.params.get("mute") is not True
        )
        if "pad_samples" not in record.params:
            if pad_purpose:
                return CutRejected("source_geometry")
            continue
        samples = record.params["pad_samples"]
        if not isinstance(samples, (list, tuple)):
            return CutRejected("source_geometry")
        for sample in samples:
            if (
                not isinstance(sample, dict)
                or not isinstance(sample.get("track_id"), str)
                or not sample["track_id"]
                or "source_id" not in sample
                or (
                    sample["source_id"] is not None
                    and (not isinstance(sample["source_id"], str) or not sample["source_id"])
                )
            ):
                return CutRejected("source_geometry")
            try:
                referenced = recording_audio_path(
                    project, sample["track_id"], sample["source_id"]
                ).resolve(strict=True)
            except (CodedError, OSError, ValueError):
                return CutRejected("source_geometry")
            if not same_recording(referenced, media):
                continue
            lo, hi = sample.get("source_start"), sample.get("source_end")
            if (
                not isinstance(lo, (int, float))
                or isinstance(lo, bool)
                or not isinstance(hi, (int, float))
                or isinstance(hi, bool)
                or not math.isfinite(lo)
                or not math.isfinite(hi)
                or lo < 0
                or hi <= lo
            ):
                return CutRejected("source_geometry")
            known_pads.append((lo, hi))
    allowed = set(ripple_track_ids(project, [track_id]))
    ignored = IgnoredWordRegions(project)
    pieces = []
    cursor = float(before_span[1])
    for placement in sorted(
        timeline.map_timeline_spans(track_id, before_span[1], after_span[0]),
        key=lambda piece: piece.timeline_start,
    ):
        if abs(float(placement.timeline_start) - cursor) > 1e-6:
            return CutRejected("source_geometry")
        cursor = float(placement.timeline_end)
        matches = [
            image
            for image in same_media
            if image.source_start <= placement.source_start + 1e-6
            and image.source_end >= placement.source_end - 1e-6
            and image.timeline_start <= placement.timeline_start + 1e-6
            and image.timeline_end >= placement.timeline_end - 1e-6
        ]
        if len(matches) != 1 or matches[0].clip.track_id not in allowed:
            continue
        clip = matches[0].clip
        if _inside_known_pad(clip, known_pads):
            continue
        clip_track = project.track_by_id(clip.track_id)
        lane_clips = sorted(
            (image.clip for image in images if image.clip.track_id == clip.track_id),
            key=lambda c: c.timeline_start,
        )
        at = lane_clips.index(clip)
        if (
            clip_track is None
            or clip_track.muted
            or clip_track.transcript_gate
            or (
                (at > 0 and uses_crossfade_join(lane_clips[at - 1], clip))
                or (at + 1 < len(lane_clips) and uses_crossfade_join(clip, lane_clips[at + 1]))
            )
        ):
            continue
        duplicated = [
            (float(other.source_start), float(other.source_end))
            for other in same_media
            if other.clip is not clip and not _inside_known_pad(other.clip, known_pads)
        ]
        excluded = [
            (region.start_s, region.end_s)
            for region in [
                *clip.mute_regions,
                *clip.off_speaker_mute_regions,
                *ignored.for_clip(clip),
            ]
        ] + duplicated
        for lo, hi in subtract_intervals(
            [
                (
                    max(before.end, float(placement.source_start)),
                    min(after.start, float(placement.source_end)),
                )
            ],
            excluded,
        ):
            shift = float(placement.timeline_start) - float(placement.source_start)
            for quiet_lo, quiet_hi in subtract_intervals(
                [(lo + shift, hi + shift)],
                [(sound.lo, sound.hi) for sound in observation.activity],
            ):
                pieces.append(
                    TimelineClipSpan(
                        TimelineSec(quiet_lo),
                        TimelineSec(quiet_hi),
                        SourceSec(quiet_lo - shift),
                        SourceSec(quiet_hi - shift),
                        clip,
                    )
                )
    if abs(cursor - float(after_span[0])) > 1e-6:
        return CutRejected("source_geometry")
    return OriginalQuietSupport(tuple(pieces))


def assess_cross_track_speech(
    project: EpisodeProject,
    cut_track_id: str,
    src_start: float,
    src_end: float,
    *,
    defaults: EffectiveConfig,
    caches: TrackRmsCacheSet | None = None,
    _admissible_spans: Sequence[tuple[float, float]] | None = None,
) -> SpeechEnergyGuardResult:
    """Return tracks that are speaking over the cut's mapped timeline window.

    A peer's own sound decides. Where it cannot be read (no stem or source audio),
    the peer's unsuppressed words whose own voice is in the window decide instead.
    """
    if src_end <= src_start or not speech_energy_guard.speech_energy_guard_enabled(defaults):
        return SpeechEnergyGuardResult(blocking_track_ids=(), action=None)

    spans = (
        list(_admissible_spans)
        if _admissible_spans is not None
        else SessionTimeline(project).map_source_span(
            cut_track_id, SourceSec(src_start), SourceSec(src_end)
        )
    )
    # A track-local hole inside the gap splits it into several mapped spans;
    # peer speech in any span at or above min_overlap can block, not just the
    # largest one (#793).
    levels = speech_energy_guard.measure_peer_speech(
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
    min_overlap = speech_energy_guard.guard_min_overlap_sec(defaults)
    blocking = levels.speaking + tuple(
        tid
        for tid, unread in levels.unread.items()
        if tid not in levels.speaking
        and speech_energy_guard.speech_words_in(
            project, tid, unread, min_overlap, voiced=True, defaults=defaults
        )
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
        action=speech_energy_guard.speech_energy_on_conflict(defaults),
        cut_rms_db=levels.owner_rms_db,
        other_rms_db=levels.peer_rms_db,
    )


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
    defaults: EffectiveConfig,
    caches: TrackRmsCacheSet | None = None,
    _admissible_spans: Sequence[tuple[float, float]] | None = None,
) -> CutScopeResolution:
    if requested_scope == "track":
        return ResolvedCutScope("intentional_track")

    try:
        from podcast_mcp.engines.speaker_id import (
            assess_speaker_cut_role,
            load_all_profiles,
        )
        from podcast_mcp.project.transcript_context import load_transcript_context

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
    # skip and review: never session-ripple over live peer speech.
    return ResolvedCutScope("peer_speech", guard)


@dataclass(frozen=True)
class PeerObservations:
    mapped: CutScopeResolution | None
    removed: CutSpeech | None


def _peer_policy(
    evidence: PeerObservations,
    *,
    edit_id: str,
    manual: bool,
    owned: bool,
) -> CutScopeHold | CutSpeechConfirmation | None:
    if manual:
        return None
    mapped = evidence.mapped
    if isinstance(mapped, CutScopeUnavailable):
        return CutScopeHold(edit_id, (), "scope_unavailable")
    if mapped is not None and mapped.cause in {"peer_speech", "speaker_bleed"}:
        return CutScopeHold(
            edit_id,
            mapped.guard.blocking_track_ids if mapped.guard else (),
            "speaker_bleed" if mapped.cause == "speaker_bleed" else "peer_speech",
        )
    if evidence.removed is not None:
        return cut_speech.confirmation_for(evidence.removed, owned=owned)
    return None


def assess_proposed_cut(
    project: EpisodeProject,
    track_id: str,
    cut_start: float,
    cut_end: float,
    *,
    timebase: Literal["source", "timeline"] = "source",
    config: JoinContinuityConfig | None = None,
    defaults: EffectiveConfig,
    audio_caches: dict[str, TrackAudioCache] | None = None,
) -> JoinContinuityReport:
    cfg = config or JoinContinuityConfig.from_defaults(defaults)
    if cut_end <= cut_start:
        raise CodedValueError(
            "cut_end must be > cut_start. Pick a cut_end later than cut_start.",
            code="range_end_before_start",
        )
    samples = join_continuity._resolve_source_samples(
        project, track_id, cfg.sample_rate, audio_caches=audio_caches
    )
    cfg = cfg.at_levels(
        join_continuity.track_level_profile(project, track_id, (audio_caches or {}).get(track_id))
    )
    st = SessionTimeline(project)
    if timebase == "timeline":
        mapped0 = st.timeline_to_source(track_id, TimelineSec(cut_start))
        mapped1 = st.timeline_to_source(track_id, TimelineSec(cut_end))
        if mapped0 is None or mapped1 is None:
            raise CodedValueError(
                f"timeline cut {cut_start}->{cut_end} falls in a gap on track {track_id!r}. Pick a range inside the track's clips.",
                code="no_clip_at_time",
            )
        src0, src1 = float(mapped0), float(mapped1)
    else:
        src0, src1 = float(cut_start), float(cut_end)
    i0, i1 = join_continuity._splice_indices((src0, src1), cfg.sample_rate)
    worst = join_continuity._worst_placement(samples, cfg.sample_rate, i0, i1, cfg)
    return join_continuity._finalize(
        track_id=track_id,
        mode="proposed_cut",
        join_sec=float(cut_start),
        timebase=timebase,
        risk=worst.risk,
        hits=worst.hits,
        samples=samples,
        cfg=cfg,
        extra_reasons=[
            f"cut {cut_start:.3f}->{cut_end:.3f} ({timebase})",
            *worst.reasons(cfg, cfg.sample_rate),
        ],
        artifacts_dir=project.artifacts_dir(),
    )


EDGE_NUDGE_MAX_SEC = 0.5
VOICE_EDGE_PAD_SEC = 0.06
INTERIOR_SPEECH_MIN_SEC = 0.1


@dataclass(frozen=True)
class VoicedEdgeAssessment:
    start: float
    end: float
    # ``interior_speech``: the span holds voice the ripple would delete (a pause's
    # own track, or any track a session cut removes the window from).
    # ``interior_audio``: a pause span is not dead air on every track it ripples.
    # ``voiced_edge``: an edge sits in kept voice and no in-bounds nudge frees it.
    flag: str | None = None


def assess_voiced_edges(
    cut_start: float,
    cut_end: float,
    *,
    selected_start: float,
    selected_end: float,
    pause: bool,
    audio_cache: TrackAudioCache,
    word_index: CutWordIndex,
    peer_caches: Sequence[TrackAudioCache] = (),
    accept_nudge: Callable[[tuple[float, float], float, float], tuple[float, float] | None]
    | None = None,
    end_in_valley: bool = False,
) -> VoicedEdgeAssessment:
    """Classify held edges; candidate preparation alone may supply an in-bounds nudge.

    ``end_in_valley`` ends this track's voiced runs at a valley a listener hears as a
    boundary (:data:`HEARD_APART_DEPTH_DB`), for a cut whose end was placed in one
    (:func:`~podcast_mcp.edits.word_onset.edge_decays_into_valley`) or the fade-in region
    that follows it. It applies to both edges because it cannot be limited to the end:
    the fade-in's start is that same valley. A cut's own start lies after the previous
    word's voice (:func:`~podcast_mcp.edits.word_onset.voice_end`), so a valley split
    cannot free a start edge that sat inside kept voice, unless it sits in a valley
    ``HEARD_APART_DEPTH_DB`` deep, which is a break a listener hears.
    """
    reach = EDGE_NUDGE_MAX_SEC + VOICE_EDGE_PAD_SEC + FRAME_SEC
    window_lo, window_hi = cut_start - reach, cut_end + reach
    own_runs = voiced_runs(
        audio_cache.waveform,
        window_lo,
        window_hi,
        floor_db=audio_cache.profile.voice_floor_db,
        split_at_valleys=end_in_valley,
    )
    peer_runs = [
        voiced_runs(c.waveform, window_lo, window_hi, floor_db=c.profile.voice_floor_db)
        for c in peer_caches
    ]
    span_lo = min(selected_start, cut_start)
    span_hi = max(selected_end, cut_end)

    def kept_word_in(lo: float, hi: float) -> bool:
        # A run cut off by the window may go on into a word the window never saw.
        if lo <= window_lo + FRAME_SEC:
            lo = -math.inf
        if hi >= window_hi - FRAME_SEC:
            hi = math.inf
        return word_index.kept_word_overlaps(lo, hi, exclude_start=span_lo, exclude_end=span_hi)

    needs_review = False
    for runs, own in ((own_runs, True), *((runs, False) for runs in peer_runs)):
        run = run_straddling(runs, cut_start)
        if run is not None:
            nudged = None
            if accept_nudge is not None and (not own or kept_word_in(run[0], cut_start)):
                nudged = accept_nudge((cut_start, cut_end), run[1] + VOICE_EDGE_PAD_SEC, cut_end)
            if nudged is None:
                needs_review = True
            else:
                cut_start = nudged[0]
        run = run_straddling(runs, cut_end)
        if run is not None:
            nudged = None
            if accept_nudge is not None and (not own or kept_word_in(cut_end, run[1])):
                nudged = accept_nudge((cut_start, cut_end), cut_start, run[0] - VOICE_EDGE_PAD_SEC)
            if nudged is None:
                needs_review = True
            else:
                cut_end = nudged[1]
    deleted = [*peer_runs, *([own_runs] if pause else [])]
    if any(
        voiced_sec_inside(runs, cut_start, cut_end) >= INTERIOR_SPEECH_MIN_SEC for runs in deleted
    ):
        return VoicedEdgeAssessment(cut_start, cut_end, "interior_speech")
    if pause and any(
        voiced_sec_inside(
            audible_runs(c.waveform, cut_start, cut_end, floor_db=c.profile.voice_floor_db),
            cut_start,
            cut_end,
        )
        >= INTERIOR_SPEECH_MIN_SEC
        for c in (audio_cache, *peer_caches)
    ):
        return VoicedEdgeAssessment(cut_start, cut_end, "interior_audio")
    return VoicedEdgeAssessment(cut_start, cut_end, "voiced_edge" if needs_review else None)


@dataclass(frozen=True)
class HeldAcoustics:
    flags: tuple[str, ...] = ()

    @property
    def needs_review(self) -> bool:
        return bool(self.flags)


@dataclass(frozen=True)
class CutAudioEffect:
    track_id: str
    source_id: str | None
    recording: Path
    start: float
    end: float
    join: CutJoin
    contributors: frozenset[str]
    retained: bool = False
    envelope: GainRamp | MuteSampleEnvelope | None = None
    timeline_start: float = 0.0
    before: PlacedSource | None = None


def completed_audio_effects(
    before: EpisodeProject,
    candidate: EpisodeProject,
    contributors: frozenset[str],
    *,
    defaults: dict,
    contributors_by_clip: Mapping[str, frozenset[str]] | None = None,
    introduced_clips: frozenset[str] = frozenset(),
) -> tuple[CutAudioEffect, ...]:
    from podcast_mcp.edits.clips_ops import clips_for_track
    from podcast_mcp.edits.track_media import full_span_clip
    from podcast_mcp.engines.audio import placed_sources
    from podcast_mcp.engines.timeline_render import placed_track_audio

    effects: list[CutAudioEffect] = []
    curve = str(defaults.get("render", {}).get("crossfade_curve", "tri"))
    for track in candidate.tracks:
        if track == before.track_by_id(track.id) and clips_for_track(
            before, track.id
        ) == clips_for_track(candidate, track.id):
            continue
        clip_sets = []
        for project in (before, candidate):
            clips = clips_for_track(project, track.id)
            lane = project.track_by_id(track.id)
            if (
                not clips
                and lane
                and not lane.timeline_empty
                and lane.media
                and lane.media.duration_sec
            ):
                clips = [full_span_clip(track.id, lane.media.duration_sec)]
            clip_sets.append(clips)
        old_clips, new_clips = clip_sets
        if old_clips == new_clips:
            continue
        graphs = []
        for project, clips in ((before, old_clips), (candidate, new_clips)):
            graphs.append(
                placed_sources(
                    placed_track_audio(project, track, clips).audio,
                    crossfade_curve=curve,
                )
                if clips
                else []
            )
        old, new = graphs
        bindings = _before_occurrences(old, new, introduced_clips)

        def append(
            leaf: PlacedSource,
            start: float,
            end: float,
            join: CutJoin,
            retained: bool = False,
            envelope: GainRamp | MuteSampleEnvelope | None = None,
            track_id: str = track.id,
            before_leaf: PlacedSource | None = None,
        ) -> None:
            source = leaf.source
            ids = (contributors_by_clip or {}).get(source.clip_id or "", contributors)
            effects.append(
                CutAudioEffect(
                    track_id,
                    source.source_id,
                    source.path.resolve(),
                    start,
                    end,
                    join,
                    ids,
                    retained,
                    envelope,
                    leaf.timeline_start + start - source.src_start,
                    before_leaf
                    if before_leaf is not None
                    and before_leaf.source.src_start <= start + _SOURCE_GEOMETRY_TOLERANCE_SEC
                    and before_leaf.source.src_end >= end - _SOURCE_GEOMETRY_TOLERANCE_SEC
                    else None,
                )
            )

        def envelopes(
            leaf: PlacedSource,
        ) -> list[tuple[float, float, CutJoin, bool, GainRamp | MuteSampleEnvelope | None]]:
            source = leaf.source
            result: list[
                tuple[float, float, CutJoin, bool, GainRamp | MuteSampleEnvelope | None]
            ] = [
                (source.src_start, source.src_start, CutJoin.SPLICE, False, None),
                (source.src_end, source.src_end, CutJoin.SPLICE, False, None),
            ]
            for ramp in leaf.ramps:
                local = replace(
                    ramp,
                    start=max(
                        source.src_start, source.src_start + ramp.start - leaf.timeline_start
                    ),
                    end=min(source.src_end, source.src_start + ramp.end - leaf.timeline_start),
                )
                result.append((local.start, local.end, CutJoin.SPLICE, True, local))
            if source.mute_spans:
                from podcast_mcp.engines.ffmpeg import FFmpegEngine

                rate = scoped_by_file(
                    "complete_effect_probe",
                    source.path,
                    None,
                    partial(FFmpegEngine().probe, source.path),
                ).sample_rate
                for mute in source.mute_spans:
                    samples = mute.samples(rate, source_start=source.src_start)
                    result.append(
                        (
                            max(source.src_start, samples.first / rate),
                            min(source.src_end, samples.last / rate),
                            CutJoin.MUTE,
                            False,
                            samples,
                        )
                    )
                    if samples.fade_out + samples.fade_in <= samples.last - samples.first:
                        for first, last in (
                            (samples.first, samples.first + samples.fade_out),
                            (samples.last - samples.fade_in, samples.last),
                        ):
                            lo, hi = (
                                max(source.src_start, first / rate),
                                min(source.src_end, last / rate),
                            )
                            if lo < hi:
                                result.append((lo, hi, CutJoin.MUTE, True, samples))
            return result

        for leaf, binding in zip(new, bindings, strict=True):
            previous = envelopes(old[binding]) if binding is not None else []
            for start, end, join, retained, envelope in envelopes(leaf):
                if not any(
                    prior_start <= start
                    and end <= prior_end
                    and (join, retained, envelope) == (prior_join, prior_retained, prior_envelope)
                    for prior_start, prior_end, prior_join, prior_retained, prior_envelope in previous
                ):
                    append(
                        leaf,
                        start,
                        end,
                        join,
                        retained,
                        envelope,
                        before_leaf=old[binding] if binding is not None else None,
                    )
        for index, leaf in enumerate(old):
            surviving = [
                (n.source.src_start, n.source.src_end)
                for n, binding in zip(new, bindings, strict=True)
                if binding == index
            ]
            for start, end in subtract_intervals(
                [(leaf.source.src_start, leaf.source.src_end)], surviving
            ):
                append(leaf, start, end, CutJoin.SPLICE, before_leaf=leaf)
    return tuple(effects)


def _before_occurrences(
    old: Sequence[PlacedSource],
    new: Sequence[PlacedSource],
    introduced_clips: frozenset[str],
) -> list[int | None]:
    """Bind each surviving renderer leaf without conflating repeated source plays."""
    from podcast_mcp.edits.clips_ops import clip_split_origin

    before_ids = {leaf.source.clip_id for leaf in old}
    bindings: list[int | None] = [None] * len(new)
    for position in sorted(range(len(new)), key=lambda i: new[i].source.is_fill):
        leaf = new[position]
        source = leaf.source
        if source.clip_id in introduced_clips:
            continue
        qualified = [
            index
            for index, previous in enumerate(old)
            if previous.source.source_id == source.source_id
            and previous.source.is_fill == source.is_fill
            and same_recording(previous.source.path, source.path)
        ]
        origin = clip_split_origin(source.clip_id, before_ids)
        containing = [
            i
            for i in qualified
            if old[i].source.src_start <= source.src_start + _SOURCE_GEOMETRY_TOLERANCE_SEC
            and old[i].source.src_end >= source.src_end - _SOURCE_GEOMETRY_TOLERANCE_SEC
        ]
        if not containing and not source.is_fill:
            # A trim that extends a clip's edge keeps all of the clip's old audio inside the new
            # leaf; that old leaf is the one this leaf continues, not a removal.
            containing = [
                i
                for i in qualified
                if old[i].source.clip_id == source.clip_id
                and source.src_start <= old[i].source.src_start + _SOURCE_GEOMETRY_TOLERANCE_SEC
                and source.src_end >= old[i].source.src_end - _SOURCE_GEOMETRY_TOLERANCE_SEC
            ]
        matches = (
            [i for i in containing if old[i].source.clip_id == origin]
            if origin in before_ids
            else containing
        )
        if source.is_fill:
            parents = [
                (n, old[binding])
                for n, binding in zip(new, bindings, strict=True)
                if not n.source.is_fill
                and n.source.clip_id == source.clip_id
                and binding is not None
            ]
            matches = [
                i
                for i in matches
                if any(
                    old[i].source.clip_id == prior.source.clip_id
                    and abs(
                        old[i].timeline_start
                        - old[i].source.src_start
                        - leaf.timeline_start
                        + source.src_start
                        - prior.timeline_start
                        + prior.source.src_start
                        + parent.timeline_start
                        - parent.source.src_start
                    )
                    <= _SOURCE_GEOMETRY_TOLERANCE_SEC
                    for parent, prior in parents
                )
            ]
        if len(matches) > 1:
            raise DuplicateSourceOccurrence("ambiguous BEFORE source occurrence")
        if matches:
            bindings[position] = matches[0]
    for i, binding in enumerate(bindings):
        if binding is None:
            continue
        if any(
            other_binding == binding
            and min(new[i].source.src_end, other.source.src_end)
            > max(new[i].source.src_start, other.source.src_start) + _SOURCE_GEOMETRY_TOLERANCE_SEC
            for other, other_binding in zip(new[:i], bindings[:i], strict=True)
        ):
            raise DuplicateSourceOccurrence("duplicated BEFORE source occurrence")
    return bindings


def complete_effect_acoustics(
    project: EpisodeProject,
    effects: Sequence[CutAudioEffect],
    *,
    defaults: dict,
    manual_ids: frozenset[str] = frozenset(),
    pauses: Mapping[str, HeldPause | CutRejected | None] | None = None,
    join: CutJoin | None = None,
    unavailable: frozenset[str] = frozenset(),
) -> list[CutScopeHold]:
    pause_holds = [
        CutScopeHold(
            edit_id,
            tuple(lane.track_id for lane in pause.unavailable_lanes),
            "pause_air",
            pause.unavailable_lanes,
            pause.skip,
        )
        for edit_id, pause in (pauses or {}).items()
        if edit_id not in manual_ids and isinstance(pause, CutRejected)
    ]
    paused = {hold.edit_id for hold in pause_holds}
    from podcast_mcp.edits.audio_cache import recording_audio_cache

    joins: dict[str, str] = {}
    heard_caches: dict[str, TrackAudioCache] = {}
    source_caches: dict[Path, TrackAudioCache] = {}
    join_subjects: dict[str, tuple[str, float, Path] | None] = {}
    join_scored: set[str] = set()
    if defaults.get("tighten", {}).get("join_continuity_gate", False):
        from podcast_mcp.util.tracks import recording_audio_path

        for edit_id, pause in (pauses or {}).items():
            if pause is None or edit_id in manual_ids or edit_id in paused:
                continue
            edit = next((item for item in project.edit_decisions if item.id == edit_id), None)
            try:
                if edit is None:
                    raise CodedValueError(
                        "pause contributor has no current edit. Refresh the pending edits and try again.",
                        code="pause_edit_missing",
                    )
                recording = recording_audio_path(project, edit.track_id, edit.source_id)
                recording = recording.resolve(strict=True)
                placements: list[tuple[str, float]] = []
                unresolved_placement = False
                for effect in effects:
                    if (
                        edit_id not in effect.contributors
                        or effect.envelope is not None
                        or effect.join is not CutJoin.SPLICE
                        or effect.start >= effect.end
                        or effect.start >= edit.end
                        or effect.end <= edit.start
                    ):
                        continue
                    try:
                        if not same_recording(effect.recording, recording):
                            continue
                    except (OSError, ValueError, subprocess.SubprocessError):
                        unresolved_placement = True
                        continue
                    if effect.before is None:
                        unresolved_placement = True
                        continue
                    offset = effect.before.timeline_start - effect.before.source.src_start
                    if not any(
                        track_id == effect.track_id
                        and abs(existing_offset - offset) <= _SOURCE_GEOMETRY_TOLERANCE_SEC
                        for track_id, existing_offset in placements
                    ):
                        placements.append((effect.track_id, offset))
                if unresolved_placement or len(placements) != 1:
                    join_subjects[edit_id] = None
                else:
                    track_id, offset = next(iter(placements))
                    join_subjects[edit_id] = (track_id, offset, recording)
            except (KeyError, OSError, ValueError, subprocess.SubprocessError):
                join_subjects[edit_id] = None
    flags: dict[str, list[str]] = {
        edit_id: ["audio_unavailable"] for edit_id in unavailable - manual_ids - paused
    }
    for effect in effects:
        ids = effect.contributors - manual_ids - paused
        if not ids:
            continue
        try:
            if _effect_has_accepted_mute(project, effect):
                timeline_cache = heard_caches.get(effect.track_id)
                if timeline_cache is None:
                    timeline_cache = _heard_timeline_audio_cache(project, effect.track_id, defaults)
                    heard_caches[effect.track_id] = timeline_cache
                source_cache = source_caches.get(effect.recording)
                if source_cache is None:
                    source_cache = recording_audio_cache(effect.recording)
                    source_caches[effect.recording] = source_cache
                cache = _source_clock_cache(
                    timeline_cache,
                    effect.before.timeline_start - effect.before.source.src_start
                    if effect.before is not None
                    else 0.0,
                    recording_profile=(source_cache.jump.profile, source_cache.waveform.profile),
                )
            else:
                cache = recording_audio_cache(effect.recording)
        except (OSError, ValueError, subprocess.SubprocessError):
            for edit_id in ids:
                flags.setdefault(edit_id, []).append("audio_unavailable")
            continue
        measured = assess_held_source(
            project,
            effect.track_id,
            effect.start,
            effect.end,
            source_id=effect.source_id,
            join=CutJoin.PADDED
            if any((pauses or {}).get(edit_id) is not None for edit_id in ids)
            else join or effect.join,
            pause=effect.retained,
            defaults=defaults,
            retained_envelope=effect.retained,
            audio_cache=cache,
            end_in_valley=_contributor_ends_in_valley(project, ids, effect, cache),
        )
        for edit_id in ids:
            flags.setdefault(edit_id, []).extend(measured.flags)
        if (
            effect.envelope is None
            and any((pauses or {}).get(edit_id) is not None for edit_id in ids)
            and effect.start < effect.end
            and effect.join is CutJoin.SPLICE
            and defaults.get("tighten", {}).get("join_continuity_gate", False)
        ):
            quality_ids = []
            for edit_id in ids:
                if edit_id not in join_subjects:
                    continue
                subject = join_subjects[edit_id]
                if subject is None:
                    joins[edit_id] = "audio_unavailable"
                    continue
                if effect.before is None or effect.track_id != subject[0]:
                    continue
                offset = effect.before.timeline_start - effect.before.source.src_start
                if abs(offset - subject[1]) > _SOURCE_GEOMETRY_TOLERANCE_SEC:
                    continue
                try:
                    matches_recording = same_recording(effect.recording, subject[2])
                except (KeyError, OSError, ValueError, subprocess.SubprocessError):
                    joins[edit_id] = "audio_unavailable"
                    continue
                if matches_recording:
                    quality_ids.append(edit_id)
            if not quality_ids:
                continue
            join_scored.update(quality_ids)
            try:
                report = assess_proposed_cut(
                    project,
                    effect.track_id,
                    effect.start,
                    effect.end,
                    timebase="source",
                    defaults=defaults,
                    config=replace(
                        JoinContinuityConfig.from_defaults(defaults), neural=False, calibrate=False
                    ),
                    audio_caches={effect.track_id: cache},
                )
                if report.verdict != "pass":
                    joins.update(
                        (
                            edit_id,
                            "review_required" if report.verdict == "review" else "join_continuity",
                        )
                        for edit_id in quality_ids
                    )
            except (OSError, ValueError, subprocess.SubprocessError):
                joins.update((edit_id, "audio_unavailable") for edit_id in quality_ids)
    joins.update(
        (edit_id, "audio_unavailable")
        for edit_id in join_subjects.keys() - join_scored - joins.keys()
    )
    for edit_id, pause in (pauses or {}).items():
        if edit_id in manual_ids or not isinstance(pause, HeldPause):
            continue
        removed = merge_intervals(
            (effect.timeline_start, effect.timeline_start + effect.end - effect.start)
            for effect in effects
            if edit_id in effect.contributors
            and effect.envelope is None
            and effect.start < effect.end
        )
        loss = sum(end - start for start, end in removed)
        if pause_trim_is_imperceptible(loss, pause.heard_pause):
            pause_holds.append(CutScopeHold(edit_id, (), "pause_imperceptible"))
    holds = [
        CutScopeHold(edit_id, (), "acoustic_edge", detail=",".join(dict.fromkeys(reasons)))
        for edit_id, reasons in flags.items()
        if reasons
    ]
    return [
        *pause_holds,
        *holds,
        *(
            CutScopeHold(
                edit_id,
                (),
                "pause_join" if (pauses or {}).get(edit_id) is not None else "acoustic_edge",
                detail=detail,
            )
            for edit_id, detail in joins.items()
            if edit_id not in {hold.edit_id for hold in holds}
        ),
    ]


def _effect_has_accepted_mute(project: EpisodeProject, effect: CutAudioEffect) -> bool:
    before = effect.before
    if before is None:
        return False
    return any(
        before.source.src_start + mute.start < effect.end
        and effect.start < before.source.src_start + mute.end
        for mute in before.source.mute_spans
    )


def _heard_timeline_audio_cache(
    project: EpisodeProject, track_id: str, defaults: dict
) -> TrackAudioCache:
    import tempfile

    from podcast_mcp.edits.audio_cache import recording_audio_cache
    from podcast_mcp.engines.timeline_render import render_track_from_timeline

    snapshot = project.model_copy(deep=True)
    track = snapshot.track_by_id(track_id)
    if track is None or track.media is None:
        raise CodedValueError(
            f"track {track_id} has no renderable media. Add media to that track first.",
            code="track_has_no_media",
        )
    track.transcript_gate = False
    snapshot.processing_chains = [
        chain
        for chain in snapshot.processing_chains
        if chain.track_id != track_id or all(effect.bypass for effect in chain.effects)
    ]
    with tempfile.TemporaryDirectory(prefix="sharecut-cut-effect-") as temporary:
        rendered = Path(temporary) / "heard.wav"
        render_track_from_timeline(snapshot, track, rendered, defaults)
        samples = recording_audio_cache(rendered)

    return samples


def _source_clock_cache(
    cache: TrackAudioCache,
    source_to_timeline_offset: float,
    *,
    recording_profile: tuple[LevelProfile, LevelProfile] | None = None,
) -> TrackAudioCache:
    from dataclasses import replace

    return TrackAudioCache(
        jump=replace(
            cache.jump,
            timeline_offset_sec=-source_to_timeline_offset,
            recording_profile=recording_profile[0]
            if recording_profile
            else cache.jump.recording_profile,
        ),
        waveform=replace(
            cache.waveform,
            timeline_offset_sec=-source_to_timeline_offset,
            recording_profile=recording_profile[1]
            if recording_profile
            else cache.waveform.recording_profile,
        ),
    )


def _contributor_ends_in_valley(
    project: EpisodeProject, ids: frozenset[str], effect: CutAudioEffect, cache: TrackAudioCache
) -> bool:
    """Whether a contributing acoustic cut ends in the valley its sound decays into before
    the next kept word: the proposal's own rule (#1358), so approval holds what it held.

    The cut's own span decides, not the effect's: a mute's fade-in region starts in that
    valley and cannot see the hum before it.
    """
    transcript = project.transcript_for_source(effect.track_id, effect.source_id)
    for edit in project.edit_decisions:
        if edit.id not in ids or not is_acoustic_filler_reason(edit.reason):
            continue
        after = next_kept_word(transcript, edit.end)
        if after is not None and edge_decays_into_valley(cache, edit.start, edit.end, after.start):
            return True
    return False


def assess_held_source(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    source_id: str | None = None,
    join: CutJoin = CutJoin.SPLICE,
    pause: bool = False,
    fade_out_ms: float = 0,
    fade_in_ms: float = 0,
    defaults: dict[str, Any],
    audio_cache: TrackAudioCache | None = None,
    retained_envelope: bool = False,
    end_in_valley: bool = False,
) -> HeldAcoustics:
    from podcast_mcp.edits.audio_cache import source_audio_cache

    flags: list[str] = []
    try:
        cache = audio_cache or source_audio_cache(project, track_id, source_id)
    except (OSError, ValueError, subprocess.SubprocessError):
        return HeldAcoustics(("audio_unavailable",))
    words = CutWordIndex.from_transcript(
        project.transcript_for_source(track_id, source_id), track_id
    )
    lo, hi = max(0.0, start - fade_out_ms / 1000), end + fade_in_ms / 1000
    samples = cache.window(max(0.0, lo - FRAME_SEC), hi + FRAME_SEC)
    if samples.size == 0 or not np.all(np.isfinite(samples)):
        return HeldAcoustics(("audio_unavailable",))
    transcript = project.transcript_for_source(track_id, source_id)
    voice = assess_voiced_edges(
        lo,
        hi,
        selected_start=start,
        selected_end=end,
        pause=pause,
        audio_cache=cache,
        word_index=words,
        end_in_valley=end_in_valley,
    )
    if voice.flag is not None:
        flags.append(voice.flag)
    if (
        voice.flag is not None
        and transcript is not None
        and any(
            not word.suppressed
            and not word.ignored
            and any(word.start < edge < word.end for edge in (lo, start, end, hi))
            for word in transcript.words
        )
    ):
        flags.append("word_edge")
    checks = CUT_EDGE_CHECKS[join]
    from podcast_mcp.edits.breath_detect import breath_level_floor
    from podcast_mcp.engines.level_profile import frame_levels_db

    breath_floor = breath_level_floor(cache.profile.room_rms, cache.profile.speech_rms)
    support = (
        cache.window(lo, hi)
        if retained_envelope
        else np.concatenate(
            [cache.window(max(0.0, edge - FRAME_SEC), edge + FRAME_SEC) for edge in (lo, hi)]
        )
    )
    levels = frame_levels_db(support, cache.waveform.sample_rate)
    breath_support = (
        bool(np.any(levels >= 20 * math.log10(breath_floor)))
        if breath_floor > 0
        else bool(np.any(support))
    )
    if (
        checks.breaths is not BreathEdgeAction.IGNORE
        and breath_support
        and protect_cut_breaths(
            project,
            track_id,
            lo,
            hi,
            defaults=defaults,
            audio_cache=cache,
            word_index=words,
            strict=checks.breaths is BreathEdgeAction.PROTECT,
            held=True,
        )
        is None
    ):
        flags.append("breath_edge")
    return HeldAcoustics(tuple(flags))


def pause_words(
    project: EpisodeProject, track_id: str, start: float, end: float
) -> tuple[TranscriptWord, TranscriptWord] | CutRejected:
    transcript = project.transcript_for_source(track_id, None)
    words = (
        [w for w in transcript.words if not w.suppressed and not w.ignored and w.end > w.start]
        if transcript
        else []
    )
    before = max(
        (w for w in words if w.end <= start + 1e-6),
        key=lambda w: w.end,
        default=None,
    )
    after = min(
        (w for w in words if w.start >= end - 1e-6),
        key=lambda w: w.start,
        default=None,
    )
    if before is None or after is None:
        return CutRejected("no_air")
    timeline = SessionTimeline(project)
    for word in (before, after):
        span = timeline.exact_source_span(track_id, SourceSec(word.start), SourceSec(word.end))
        if span is None:
            return CutRejected("source_geometry")
    return before, after


@dataclass(frozen=True)
class HeldPause:
    effects: tuple[PauseEdgeFade, ...]
    heard_pause: float
    peer_observation_span: tuple[float, float]


def assess_held_pause(
    project: EpisodeProject,
    edit: EditDecision,
    span: tuple[TimelineSec, TimelineSec],
    *,
    defaults: dict[str, Any],
    audio_caches: dict[str, TrackAudioCache],
    manual: bool,
) -> HeldPause | CutRejected:
    from podcast_mcp.edits.breath_detect import PauseAirSkip
    from podcast_mcp.edits.cut_quality import post_pad_fade_in_bounds_ms
    from podcast_mcp.edits.ripple import TrackExtent
    from podcast_mcp.edits.session_air import SessionAir
    from podcast_mcp.edits.timeline_ops import LaneUnavailable, bind_pause_effects

    words = pause_words(project, edit.track_id, edit.start, edit.end)
    if isinstance(words, CutRejected):
        return words
    before, after = words
    timeline = SessionTimeline(project)
    before_span = timeline.exact_source_span(
        edit.track_id, SourceSec(before.start), SourceSec(before.end)
    )
    after_span = timeline.exact_source_span(
        edit.track_id, SourceSec(after.start), SourceSec(after.end)
    )
    assert before_span is not None and after_span is not None
    reach = (
        max(
            edit.crossfade_ms,
            post_pad_fade_in_bounds_ms(defaults)[1],
            int(defaults.get("tighten", {}).get("filler_pre_pad_fade_out_ms", 5)),
            max((max(c.fade_in_ms, c.fade_out_ms) for c in project.clips), default=0),
        )
        / 1000.0
    )
    observation_span = (
        min(float(span[0]) - reach, float(before_span[0])),
        max(float(span[1]) + reach, float(after_span[1])),
    )
    air = SessionAir(project, audio_caches=audio_caches)
    acoustic = not manual and bool(
        defaults.get("tighten", {}).get("breath_handling", {}).get("enabled", True)
    )
    observation = (
        GeometricPause(())
        if manual
        else air.pause_observation(*observation_span, acoustic=acoustic)
    )
    if isinstance(observation, PauseAirSkip):
        return CutRejected(observation.value)
    original = original_pause_support(project, edit.track_id, words, observation)
    if isinstance(original, CutRejected):
        return original
    if not manual:
        if acoustic:
            sounds = air.sounds_in(float(span[0]), float(span[1]), needs_speech=edit.track_id)
            if isinstance(sounds, PauseAirSkip):
                return CutRejected(sounds.value)
            for sound in sounds:
                if (
                    not sound.removable and min(sound.hi, span[1]) - max(sound.lo, span[0]) > 1e-6
                ) or any(sound.lo + 1e-6 < edge < sound.hi - 1e-6 for edge in span):
                    return CutRejected("pause_air")
        quiet = merge_intervals(
            (float(piece.source_start), float(piece.source_end)) for piece in original.pieces
        )
        retained = sum(hi - lo for lo, hi in subtract_intervals(quiet, [(edit.start, edit.end)]))
        floor, _solo = retained_pause_floor_sec(
            project, edit.track_id, before.end, after.start, defaults, None
        )
        if retained < floor - 1e-6:
            return CutRejected("no_air")
    removal = RippleRemoval.of([TrackExtent(edit.track_id, float(span[0]), float(span[1]))])
    effects = bind_pause_effects(
        project,
        float(span[0]),
        removal,
        observation=observation,
        splice_fade_ms=edit.crossfade_ms,
        defaults=defaults,
    )
    if isinstance(effects, LaneUnavailable):
        return CutRejected("pause_effects", (effects,))
    return HeldPause(
        effects,
        0.0
        if manual
        else air.silence_around(float(span[0]), float(span[1]))
        or float(after_span[0] - before_span[1]),
        observation_span,
    )


@dataclass(frozen=True)
class SourceCutObservations:
    span: tuple[TimelineSec, TimelineSec]
    placement: CutScopeHold | None
    pause: HeldPause | CutRejected | None
    peers: PeerObservations
    removal: RippleRemoval | None


@dataclass(frozen=True)
class PadEffect:
    edit_id: str
    plan: RoomTonePad
    clip_ids: frozenset[str]


def native_pad_origins() -> dict[str, PadEffect]:
    """Native tile IDs and original insertion effects, retained only for this batch."""
    return scoped("cut_pad_origins", dict)


def observe_source_cut(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    defaults: dict,
    manual: bool,
    batch: Sequence[SourceExtent],
    audio_caches: dict[str, TrackAudioCache],
    timeline_caches: TrackRmsCacheSet,
) -> SourceCutObservations:
    from podcast_mcp.edits.ripple import TrackExtent

    placement = inspect_source_remove_placement(project, edit)
    if isinstance(placement, CutScopeHold):
        witness = edit.source_timeline_span
        spans = SessionTimeline(project).map_source_span(
            edit.track_id, SourceSec(edit.start), SourceSec(edit.end)
        )
        span = (
            (TimelineSec(witness.start), TimelineSec(witness.end))
            if witness
            else spans[0]
            if spans
            else (TimelineSec(edit.start), TimelineSec(edit.end))
        )
    else:
        span = placement
    pause = (
        assess_held_pause(
            project, edit, span, defaults=defaults, audio_caches=audio_caches, manual=manual
        )
        if (edit.reason or "").startswith("pause:")
        else None
    )
    removal = (
        None
        if edit.scope == "track"
        else RippleRemoval.of([TrackExtent(edit.track_id, float(span[0]), float(span[1]))])
    )
    mapped = (
        resolve_cut_scope(
            project,
            edit.track_id,
            edit.start,
            edit.end,
            requested_scope=edit.scope or "session",
            defaults=defaults,
            caches=timeline_caches,
            _admissible_spans=((float(span[0]), float(span[1])),),
        )
        if removal
        else None
    )
    speech = (
        cut_speech.assess_cut_speech(
            project, removal, also_chosen=batch, timeline_caches=timeline_caches, defaults=defaults
        )
        if removal
        else None
    )
    return SourceCutObservations(
        span,
        placement if isinstance(placement, CutScopeHold) else None,
        pause,
        PeerObservations(mapped, speech),
        removal,
    )


def pause_edge_clips(project: EpisodeProject, edge: PauseEdgeFade) -> list[Clip]:
    from podcast_mcp.edits.clips_ops import clips_for_track
    from podcast_mcp.util.coded_error import CodedError
    from podcast_mcp.util.tracks import recording_audio_path

    matched = []
    for clip in clips_for_track(project, edge.track_id):
        if clip.source_id != edge.source_id:
            continue
        try:
            media = recording_audio_path(project, clip.track_id, clip.source_id).resolve(
                strict=True
            )
        except (CodedError, OSError, ValueError):
            continue
        if (
            same_recording(media, edge._media)
            and abs(
                (clip.source_end if edge.side == "left" else clip.source_start) - edge.source_sec
            )
            <= 1e-6
            and abs(
                (clip.timeline_end if edge.side == "left" else clip.timeline_start)
                - edge.timeline_sec
            )
            <= 1e-6
            and clip.source_start <= edge.source_start + 1e-6
            and clip.source_end >= edge.source_end - 1e-6
        ):
            matched.append(clip)
    return matched


def complete_effect_placement(
    before: EpisodeProject,
    candidate: EpisodeProject,
    edit_id: str,
    observation: SourceCutObservations | None = None,
    pads: Sequence[PadEffect] = (),
    exact_range: ExactRangeTarget | None = None,
) -> CutScopeHold | None:
    from podcast_mcp.edits.room_tone import OwnQuietSample
    from podcast_mcp.edits.timeline_ops import LaneSample

    if exact_range is not None:
        from podcast_mcp.edits.range_edits import resolve_range

        resolve_range(before, exact_range)
    if observation is not None:
        if observation.placement is not None:
            return observation.placement
        if isinstance(observation.pause, HeldPause) and any(
            len(pause_edge_clips(candidate, edge)) != 1 for edge in observation.pause.effects
        ):
            return CutScopeHold(edit_id, (), "source_geometry", detail="pause_effect_geometry")
        if (
            isinstance(observation.pause, CutRejected)
            and observation.pause.skip == "source_geometry"
        ):
            return CutScopeHold(edit_id, (), "source_geometry")
    timeline = SessionTimeline(before)
    for original_track in before.tracks:
        current_track = candidate.track_by_id(original_track.id)
        if (
            not original_track.timeline_empty
            and original_track.media
            and not any(c.track_id == original_track.id for c in before.clips)
            and (
                any(c.track_id == original_track.id for c in candidate.clips)
                or bool(current_track and current_track.timeline_empty)
            )
        ):
            if timeline.origin_placement_lanes(
                original_track.id, TimelineSec(-math.inf), TimelineSec(math.inf)
            ) - {original_track.id}:
                return CutScopeHold(edit_id, (original_track.id,), "source_geometry")
            duration = original_track.media.duration_sec
            if duration is None or not math.isfinite(duration) or duration <= 0:
                return CutScopeHold(edit_id, (), "media_extent_unavailable")
    old_tracks = {track.id: track for track in before.tracks}
    if (
        {track.id for track in candidate.tracks} != old_tracks.keys()
        or any(track.media != old_tracks[track.id].media for track in candidate.tracks)
        or any(candidate.source_by_id(source.id) != source for source in before.sources)
    ):
        return CutScopeHold(edit_id, (), "source_geometry", detail="recording_identity")
    seen: set[str] = set()
    for clip in candidate.clips:
        track = candidate.track_by_id(clip.track_id)
        source = (
            candidate.source_by_id(clip.source_id)
            if clip.source_id is not None
            else track.media
            if track
            else None
        )
        if track is None or (clip.source_id is not None and source is None) or clip.id in seen:
            return CutScopeHold(edit_id, (), "source_geometry", detail="clip_identity")
        seen.add(clip.id)
        original = next((old for old in before.clips if old.id == clip.id), None)
        if original is not None and (
            clip.track_id != original.track_id or clip.source_id != original.source_id
        ):
            return CutScopeHold(edit_id, (), "source_geometry", detail="clip_recording_identity")
        if (
            not all(
                math.isfinite(x)
                for x in (
                    clip.source_start,
                    clip.source_end,
                    clip.timeline_start,
                    clip.fade_in_ms,
                    clip.fade_out_ms,
                )
            )
            or clip.source_start < 0
            or clip.source_end <= clip.source_start
            or clip.timeline_start < 0
            or min(clip.fade_in_ms, clip.fade_out_ms) < 0
        ):
            return CutScopeHold(edit_id, (), "source_geometry")
        if (
            source
            and source.duration_sec is not None
            and clip.source_end > source.duration_sec + 1e-6
        ):
            return CutScopeHold(edit_id, (), "source_geometry", detail="recording_extent")
        for region in clip.mute_regions:
            if region.fill is None:
                continue
            fill_source = (
                candidate.source_by_id(region.fill.source_id)
                if region.fill.source_id is not None
                else track.media
            )
            if fill_source is None or (
                fill_source.duration_sec is not None
                and region.fill.end_s > fill_source.duration_sec + 1e-6
            ):
                return CutScopeHold(edit_id, (), "source_geometry", detail="fill_binding")
    for effect in pads:
        plan = effect.plan
        if (
            observation is None
            or plan.at_time < float(observation.span[0]) - 1e-6
            or plan.at_time > float(observation.span[1]) + 1e-6
        ):
            return CutScopeHold(effect.edit_id, (), "source_geometry", detail="pad_hull")
        clips = [clip for clip in candidate.clips if clip.id in effect.clip_ids]
        if len(clips) != len(effect.clip_ids):
            return CutScopeHold(effect.edit_id, (), "source_geometry", detail="pad_placement")
        for lane in plan.lanes:
            if not isinstance(lane, LaneSample):
                continue
            selected = lane.selection
            start, end, source_id = (
                (selected.sample.start, selected.sample.end, None)
                if isinstance(selected, OwnQuietSample)
                else (selected.start, selected.end, selected.source_id)
            )
            tiles = sorted(
                (clip for clip in clips if clip.track_id == lane.track_id),
                key=lambda clip: clip.timeline_start,
            )
            cursor = plan.at_time
            for tile in tiles:
                if (
                    tile.source_id != source_id
                    or tile.source_start < start - 1e-6
                    or tile.source_end > end + 1e-6
                    or abs(tile.timeline_start - cursor) > 1e-6
                ):
                    return CutScopeHold(
                        effect.edit_id, (), "source_geometry", detail="pad_source_binding"
                    )
                cursor = tile.timeline_end
            if abs(cursor - plan.at_time - plan.seconds) > 1e-6:
                return CutScopeHold(effect.edit_id, (), "source_geometry", detail="pad_coverage")
    return None


def _is_recorded_pad(
    clip: Clip,
    pad_origins: dict[str, PadEffect],
    written_by_edit: dict[str, AppliedEditRecord],
) -> bool:
    """A native pad clip that the edit which laid it recorded: its window and its samples."""
    from podcast_mcp.edits.clips_ops import clip_split_origin

    origin = pad_origins.get(clip_split_origin(clip.id, set(pad_origins)) or "")
    row = written_by_edit.get(origin.edit_id) if origin is not None else None
    return (
        origin is not None
        and row is not None
        and row.timeline_start is not None
        and origin.plan.at_time >= row.timeline_start - 1e-6
        and origin.plan.at_time + origin.plan.seconds
        <= row.timeline_start + float(row.params.get("replace_gap_sec") or 0) + 1e-6
        and any(
            sample["track_id"] == clip.track_id
            and sample.get("source_id") == clip.source_id
            and clip.source_start >= sample["source_start"] - 1e-6
            and clip.source_end <= sample["source_end"] + 1e-6
            for sample in row.params.get("pad_samples", [])
        )
    )


def complete_effect_receipts(
    before: EpisodeProject,
    candidate: EpisodeProject,
    accepted: Sequence[EditDecision] = (),
    *,
    operation_ids: frozenset[str] = frozenset(),
    removal: RippleRemoval | None = None,
    trim: TrimPlan | None = None,
    clip_ids: tuple[str, ...] = (),
) -> list[CutScopeHold]:
    pad_origins = native_pad_origins()
    old = before.editorial.edit_log
    rows = candidate.editorial.edit_log
    bad: set[str] = set()
    ids = operation_ids | frozenset(edit.id for edit in accepted)
    if rows[: len(old)] != old or len({row.id for row in rows}) != len(rows):
        bad.update(ids)
    for row in rows[len(old) :]:
        if any(candidate.track_by_id(track_id) is None for track_id in row.track_ids):
            bad.update(row.decision_ids or ids)
        for lo, hi in ((row.source_start, row.source_end), (row.timeline_start, row.timeline_end)):
            if (
                lo is not None
                and hi is not None
                and (not math.isfinite(lo) or not math.isfinite(hi) or lo < 0 or hi < lo)
            ):
                bad.update(row.decision_ids or ids)
    new_rows = rows[len(old) :]
    if trim is not None:
        original = next((clip for clip in before.clips if clip.id == trim.clip_id), None)
        clipped = next((clip for clip in candidate.clips if clip.id == trim.clip_id), None)
        if original is None or clipped is None or len(new_rows) != 1:
            bad.update(ids)
        else:
            row = new_rows[0]
            if (
                (row.source_start, row.source_end, row.timeline_start, row.timeline_end)
                != (
                    clipped.source_start,
                    clipped.source_end,
                    clipped.timeline_start,
                    clipped.timeline_end,
                )
                or row.params.get("previous_source_start") != original.source_start
                or row.params.get("previous_source_end") != original.source_end
                or row.params.get("previous_timeline_start") != original.timeline_start
                or row.params.get("previous_timeline_end") != original.timeline_end
                or set(row.track_ids) != set(trim.track_ids)
                or any(
                    not any(
                        clip.id == move.clip_id
                        and clip.track_id == move.track_id
                        and abs(
                            (clip.source_start if trim.edge == "in" else clip.source_end)
                            - move.source_sec
                        )
                        <= 1e-6
                        for clip in candidate.clips
                    )
                    for move in trim.moves
                )
            ):
                bad.update(ids)
    elif removal is not None and clip_ids:
        selected = [clip for clip in before.clips if clip.id in clip_ids]
        if len(selected) != len(set(clip_ids)) or len(new_rows) != 1:
            bad.update(ids)
        else:
            row = new_rows[0]
            if row.params.get("mode") == "ripple":
                expected_spans = {
                    tid: [list(span) for span in removal.spans]
                    for tid in ripple_track_ids(before, removal.edited_track_ids)
                }
            else:
                expected_spans = {}
                for clip in sorted(selected, key=lambda c: c.timeline_start, reverse=True):
                    expected_spans.setdefault(clip.track_id, []).append(
                        [clip.timeline_start, clip.timeline_end]
                    )
            if (
                row.params.get("cut_spans") != expected_spans
                or row.params.get("clip_ids") != list(clip_ids)
                or any(clip.id in clip_ids for clip in candidate.clips)
            ):
                bad.update(ids)
    elif removal is not None:
        if {(row.timeline_start, row.timeline_end) for row in new_rows} != set(removal.spans):
            bad.update(ids)
        from podcast_mcp.edits.clips_ops import clips_for_track
        from podcast_mcp.edits.edit_log import seam_source_by_track

        for row in new_rows:
            if row.timeline_start is None or row.timeline_end is None:
                bad.update(ids)
                continue
            expected = seam_source_by_track(
                {tid: clips_for_track(before, tid) for tid in row.track_ids},
                row.timeline_start,
                row.timeline_end,
            )
            if row.params.get("per_track_source") != expected:
                bad.update(ids)
    written_by_edit = {
        edit.id: written[0]
        for edit in accepted
        if len(written := [row for row in new_rows if edit.id in row.decision_ids]) == 1
    }
    for edit in accepted:
        if edit.exact_range is not None and edit.type not in (
            EditDecisionType.REMOVE,
            EditDecisionType.MUTE,
        ):
            bad.add(edit.id)
        previous = [row for row in old if edit.id in row.decision_ids]
        written = [row for row in rows[len(old) :] if edit.id in row.decision_ids]
        if previous or len(written) != 1:
            bad.add(edit.id)
            continue
        row = written[0]
        if edit.exact_range is None and (
            row.source_start != edit.start or row.source_end != edit.end
        ):
            bad.add(edit.id)
        if edit.source_timeline_span is not None and row.params.get("source_id") != edit.source_id:
            bad.add(edit.id)
        if (
            edit.type is EditDecisionType.REMOVE
            and edit.exact_range is None
            and not row.params.get("mute")
        ):
            source_ids = before.equivalent_source_ids(edit.track_id, edit.source_id)
            if any(
                clip.source_id in source_ids
                and clip_plays_lane(candidate, clip, edit.track_id)
                and min(edit.end, clip.source_end) - max(edit.start, clip.source_start) > 1e-6
                and not _is_recorded_pad(clip, pad_origins, written_by_edit)
                for clip in candidate.clips
            ):
                bad.add(edit.id)
    return [
        CutScopeHold(edit_id, (), "source_geometry", detail="source_receipt")
        for edit_id in sorted(bad)
    ]


def safety_observation_label(hold: CutScopeHold) -> str:
    if hold.detail in SAFETY_LABELS:
        return hold.detail
    if hold.detail and hold.detail.startswith("breath"):
        return "breath_edge"
    if hold.reason == "acoustic_edge" and hold.detail and "breath" in hold.detail:
        return "breath_edge"
    return hold.reason


def hold_is_overridable(hold: CutScopeHold) -> bool:
    """Whether the owner's audio-check override can clear this hold (an audio-quality or
    cut-position check, not a project-integrity one)."""
    return action_for_safety_observation(safety_observation_label(hold), "ripple").acoustic_override


def apply_safety_actions(
    project: EpisodeProject,
    holds: Sequence[CutScopeHold],
    *,
    manual_ids: frozenset[str] = frozenset(),
    mode: CutMode | None = None,
) -> list[CutScopeHold]:
    decisions = {edit.id: edit for edit in project.edit_decisions}
    retained: list[CutScopeHold] = []
    for hold in holds:
        edit = decisions.get(hold.edit_id)
        actual_mode = mode or (edit_time_behavior(edit) if edit is not None else "ripple")
        policy = action_for_safety_observation(safety_observation_label(hold), actual_mode)
        if policy.action != "review":
            continue
        if hold.edit_id in manual_ids and policy.acoustic_override:
            continue
        retained.append(hold)
    return retained


def assess_source_offer(project: EpisodeProject, edit: EditDecision, *, defaults: dict) -> None:
    from podcast_mcp.edits.cut_application import assess_offer

    if edit.boundary_intent is CutIntent.HUMAN_BOUNDARIES or edit.type == EditDecisionType.SPLIT:
        return
    holds = assess_offer(project, edit, defaults=defaults)
    reason = (edit.reason or "").partition(":acoustic_review:")[0]
    edit.reason = reason
    mode: CutMode = "mute" if edit.type is EditDecisionType.MUTE else "ripple"
    labels = [
        safety_observation_label(hold)
        for hold in holds
        if action_for_safety_observation(safety_observation_label(hold), mode).action == "review"
    ]
    if labels:
        edit.review_required = True
        edit.reason = f"{reason}:acoustic_review:{','.join(dict.fromkeys(labels))}"


def inspect_source_remove(
    project: EpisodeProject,
    edit: EditDecision,
    *,
    heard_pause_sec: float | None = None,
    audio_caches: Mapping[str, TrackAudioCache] | None = None,
    placement: tuple[TimelineSec, TimelineSec] | None = None,
) -> tuple[float, float] | CutScopeHold:
    """Assess final ordinary SOURCE bounds without publishing or authorizing a later mutation."""
    span: tuple[TimelineSec, TimelineSec] | CutScopeHold
    span = placement if placement is not None else inspect_source_remove_placement(project, edit)
    if isinstance(span, CutScopeHold):
        return span
    if (edit.reason or "").startswith("pause:"):
        timeline = SessionTimeline(project)
        loss = float(span[1] - span[0]) - (edit.replace_gap_sec or 0.0)
        if loss <= 0:
            return CutScopeHold(edit.id, (), "pause_not_shorter")
        heard = heard_pause_sec
        if heard is None:
            from podcast_mcp.edits.session_air import SessionAir

            heard = SessionAir(project, audio_caches=audio_caches or {}).silence_around(
                float(span[0]), float(span[1])
            )
        if heard is None:
            transcript = project.transcript_for_track(edit.track_id)
            words = (
                [w for w in transcript.words if not w.suppressed and not w.ignored]
                if transcript
                else []
            )
            before = max((w.end for w in words if w.end <= edit.start), default=None)
            after = min((w.start for w in words if w.start >= edit.end), default=None)
            if before is not None and after is not None:
                heard = sum(
                    float(e - s)
                    for s, e in timeline.map_source_span(
                        edit.track_id, SourceSec(before), SourceSec(after)
                    )
                )
            else:
                heard = float(span[1] - span[0])
        if pause_trim_is_imperceptible(loss, heard):
            return CutScopeHold(edit.id, (), "pause_imperceptible")
    return float(span[0]), float(span[1])
