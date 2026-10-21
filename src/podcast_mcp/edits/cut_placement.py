"""Placement proof for a source cut: which lanes play the origin, where it lands, and what holds it.

The bottom of the cut-safety stack. Nothing here reads audio; ``cut_effects`` and ``cut_safety``
build on these types and checks."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import TYPE_CHECKING, Literal

from podcast_mcp.edits.clips_ops import uses_crossfade_join
from podcast_mcp.edits.mute_regions import IgnoredWordRegions
from podcast_mcp.edits.ripple import ripple_track_ids
from podcast_mcp.edits.room_tone import room_tone_source_id
from podcast_mcp.edits.session_air import GeometricPause, MeasuredPause
from podcast_mcp.edits.track_media import full_span_clip
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    TimelineClipSpan,
    clip_plays_lane,
    clip_timeline_overlap_to_source,
    origin_track_id_for_clip,
)
from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    TranscriptWord,
)
from podcast_mcp.util.coded_error import CodedError, CodedValueError
from podcast_mcp.util.intervals import merge_intervals, subtract_intervals
from podcast_mcp.util.media_identity import same_recording
from podcast_mcp.util.timebase import SourceSec, TimelineSec
from podcast_mcp.util.tracks import recording_audio_path
from podcast_mcp.util.workspace_paths import resolve_under_workspace

if TYPE_CHECKING:
    from podcast_mcp.edits.timeline_ops import LaneUnavailable


SOURCE_GEOMETRY_TOLERANCE_SEC = 1e-6


class DuplicateSourceOccurrence(ValueError):
    """A completed edit reused or replayed one source occurrence."""


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
            hi <= lo + SOURCE_GEOMETRY_TOLERANCE_SEC
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
        if hi <= lo + SOURCE_GEOMETRY_TOLERANCE_SEC:
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
            abs(actual_lo - expected_lo) > SOURCE_GEOMETRY_TOLERANCE_SEC
            or abs(actual_hi - expected_hi) > SOURCE_GEOMETRY_TOLERANCE_SEC
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
        if right <= left + SOURCE_GEOMETRY_TOLERANCE_SEC:
            continue
        covering = [
            clip
            for clip, lo, hi in selected_pieces
            if lo <= left + SOURCE_GEOMETRY_TOLERANCE_SEC
            and hi >= right - SOURCE_GEOMETRY_TOLERANCE_SEC
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
        lo - SOURCE_GEOMETRY_TOLERANCE_SEC <= clip.source_start
        and clip.source_end <= hi + SOURCE_GEOMETRY_TOLERANCE_SEC
        for lo, hi in pads
    )


def original_pause_support(
    project: EpisodeProject,
    track_id: str,
    words: tuple[TranscriptWord, TranscriptWord],
    observation: GeometricPause | MeasuredPause,
) -> OriginalQuietSupport | CutRejected:

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
