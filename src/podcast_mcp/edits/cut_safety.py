from __future__ import annotations

import logging
import math
from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum
from itertools import pairwise
from typing import TYPE_CHECKING, Any, Literal, TypeAlias, overload

import numpy as np

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
from podcast_mcp.edits.cut_speech import CutSpeechConfirmation, SourceExtent, SpeechClearance
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.edits.join_continuity import JoinContinuityConfig, JoinContinuityReport
from podcast_mcp.edits.mute_regions import IgnoredWordRegions
from podcast_mcp.edits.ripple import RippleRemoval, ripple_track_ids
from podcast_mcp.edits.session_air import GeometricPause, MeasuredPause
from podcast_mcp.edits.speech_energy_guard import SpeechEnergyGuardResult
from podcast_mcp.engines.audio_audit import TrackRmsCacheSet
from podcast_mcp.engines.level_profile import LEVEL_FRAME_SEC, level_profile
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    TimelineClipSpan,
    clip_plays_lane,
    clip_timeline_overlap_to_source,
    origin_track_id_for_clip,
)
from podcast_mcp.models import EditDecision, EditDecisionType, EpisodeProject, TranscriptWord
from podcast_mcp.util.intervals import merge_intervals, subtract_intervals
from podcast_mcp.util.media_identity import same_recording
from podcast_mcp.util.timebase import SourceSec, TimelineSec
from podcast_mcp.util.tracks import dialogue_track_ids

if TYPE_CHECKING:
    from podcast_mcp.edits.timeline_ops import LaneUnavailable

log = logging.getLogger(__name__)
_SOURCE_GEOMETRY_TOLERANCE_SEC = 1e-6


class CutJoin(Enum):
    SPLICE = "splice"
    PADDED = "padded"
    MUTE = "mute"


class BreathEdgeAction(Enum):
    PROTECT = "protect"
    KEEP_WHOLE = "keep_whole"
    IGNORE = "ignore"


@dataclass(frozen=True)
class CutEdgeChecks:
    breaths: BreathEdgeAction
    score_joins: bool
    end_before_next_onset: bool
    keep_whole_words: bool
    refuse_attached_runs: bool
    audible_only: bool
    peer_scoped: bool


CUT_EDGE_CHECKS = {
    CutJoin.SPLICE: CutEdgeChecks(
        breaths=BreathEdgeAction.PROTECT,
        score_joins=True,
        end_before_next_onset=False,
        keep_whole_words=False,
        refuse_attached_runs=False,
        audible_only=False,
        peer_scoped=True,
    ),
    CutJoin.PADDED: CutEdgeChecks(
        breaths=BreathEdgeAction.IGNORE,
        score_joins=False,
        end_before_next_onset=True,
        keep_whole_words=True,
        refuse_attached_runs=False,
        audible_only=False,
        peer_scoped=True,
    ),
    CutJoin.MUTE: CutEdgeChecks(
        breaths=BreathEdgeAction.KEEP_WHOLE,
        score_joins=False,
        end_before_next_onset=True,
        keep_whole_words=True,
        refuse_attached_runs=True,
        audible_only=True,
        peer_scoped=False,
    ),
}


def protect_cut_breaths(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    defaults: dict | None = None,
    sample_rate: int = 16000,
    audio_cache: TrackAudioCache | None = None,
    word_index: CutWordIndex | None = None,
    strict: bool = True,
) -> tuple[float, float] | None:
    """Shrink final edges around complete breaths, or suppress uncertain cuts."""
    if not (math.isfinite(start) and math.isfinite(end) and start < end):
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
        )

    evidence = [
        inspect(edge, window, (start, end))
        for edge, window in zip((start, end), windows, strict=True)
    ]
    if strict and any(isinstance(item, _UncertainEdge) for item in evidence):
        return None
    new_start = evidence[0].span.end if isinstance(evidence[0], _CompleteEdgeBreath) else start
    new_end = evidence[1].span.start if isinstance(evidence[1], _CompleteEdgeBreath) else end
    if new_start >= new_end:
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
    defaults: dict | None = None,
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
        edit.type != EditDecisionType.REMOVE
        or edit.exact_range is not None
        or edit.timebase != "source"
    ):
        raise ValueError("ordinary source remove required")
    pause = (edit.reason or "").startswith("pause:")
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
    if span is None or (
        edit.source_timeline_span is None
        and timeline.exact_timeline_source_span(
            edit.track_id,
            *span,
            on_origin_lane=edit.scope == "track",
        )
        is None
    ):
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
        if edit.scope == "track"
        else set(ripple_track_ids(project, [edit.track_id]))
    )
    if not lanes or not lanes <= allowed:
        return CutScopeHold(edit.id, (), "operation_scope")
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


def _spans_agree(got: tuple[float, float] | None, want: tuple[float, float]) -> bool:
    """Whether a span mapped there and back lands on ``want``, within float error (#1560)."""
    return got is not None and all(abs(g - w) <= 1e-9 for g, w in zip(got, want, strict=True))


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
            if other.clip is not clip
        ]
        excluded = (
            [
                (region.start_s, region.end_s)
                for region in [*clip.mute_regions, *ignored.for_clip(clip)]
            ]
            + known_pads
            + duplicated
        )
        for lo, hi in subtract_intervals(
            [
                (
                    max(before.end, float(placement.source_start)),
                    min(after.start, float(placement.source_end)),
                )
            ],
            excluded,
        ):
            if hi <= lo:
                continue
            mapped = timeline.exact_source_span(track_id, SourceSec(lo), SourceSec(hi))
            if mapped is None or not _spans_agree(
                timeline.exact_timeline_source_span(track_id, *mapped), (lo, hi)
            ):
                continue
            for quiet_lo, quiet_hi in subtract_intervals(
                [(float(mapped[0]), float(mapped[1]))],
                [(sound.lo, sound.hi) for sound in observation.activity],
            ):
                source = timeline.exact_timeline_source_span(
                    track_id, TimelineSec(quiet_lo), TimelineSec(quiet_hi)
                )
                if source is not None and _spans_agree(
                    timeline.exact_source_span(track_id, *source), (quiet_lo, quiet_hi)
                ):
                    pieces.append(
                        TimelineClipSpan(
                            TimelineSec(quiet_lo), TimelineSec(quiet_hi), *source, clip
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
    defaults: dict[str, Any] | None = None,
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
        and speech_energy_guard.speech_words_in(project, tid, unread, min_overlap, voiced=True)
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
    # skip and review: never session-ripple over live peer speech.
    return ResolvedCutScope("peer_speech", guard)


@overload
def clear_ripple(
    project: EpisodeProject,
    removal: RippleRemoval | None,
    *,
    confirm_cut_speech: Literal[True],
    also_chosen: Sequence[SourceExtent] = (),
    defaults: dict[str, Any] | None = None,
    timeline_caches: TrackRmsCacheSet | None = None,
) -> SpeechClearance: ...


@overload
def clear_ripple(
    project: EpisodeProject,
    removal: RippleRemoval | None,
    *,
    confirm_cut_speech: bool,
    also_chosen: Sequence[SourceExtent] = (),
    defaults: dict[str, Any] | None = None,
    timeline_caches: TrackRmsCacheSet | None = None,
) -> SpeechClearance | CutSpeechConfirmation: ...


def clear_ripple(
    project: EpisodeProject,
    removal: RippleRemoval | None,
    *,
    confirm_cut_speech: bool,
    also_chosen: Sequence[SourceExtent] = (),
    defaults: dict[str, Any] | None = None,
    timeline_caches: TrackRmsCacheSet | None = None,
) -> SpeechClearance | CutSpeechConfirmation:
    """The one guard every rippling path calls before it removes time.

    Clears ``removal`` to apply, or asks to confirm the speech it would cut outside
    what it selected (``removal.selected``, plus ``also_chosen`` for the rest of an
    approval batch). Confirmed, the clearance carries that speech for the record.
    """
    if removal is None:
        return SpeechClearance(None)
    speech = cut_speech.assess_cut_speech(
        project,
        removal,
        also_chosen=also_chosen,
        defaults=defaults,
        timeline_caches=timeline_caches,
    )
    if speech is None:
        return SpeechClearance(removal)
    if not confirm_cut_speech:
        return cut_speech.confirmation_for(speech, owned=bool(removal.selected))
    return SpeechClearance(removal, cut_speech=speech)


def assess_proposed_cut(
    project: EpisodeProject,
    track_id: str,
    cut_start: float,
    cut_end: float,
    *,
    timebase: Literal["source", "timeline"] = "source",
    config: JoinContinuityConfig | None = None,
    defaults: dict[str, Any] | None = None,
    audio_caches: dict[str, TrackAudioCache] | None = None,
) -> JoinContinuityReport:
    cfg = config or JoinContinuityConfig.from_defaults(defaults)
    if cut_end <= cut_start:
        raise ValueError("cut_end must be > cut_start")
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
            raise ValueError(
                f"timeline cut {cut_start}->{cut_end} falls in a gap on track {track_id!r}"
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
