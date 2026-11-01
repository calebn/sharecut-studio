"""Put a saved segment on the timeline: tracks, sources, clips and an optional chapter.

The project half of Insert. ``services/segment_insert.py`` copies and verifies the audio
first; this runs inside the undoable mutation and only edits the project. It opens time
with the same ripple as ``insert_gap`` and ``paste_segment`` do, so later content, chapters
and review comments move with it.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.comment_remap import shift_review_anchors_for_insert
from podcast_mcp.edits.ripple import ripple_insert_clips, ripple_track_ids
from podcast_mcp.engines.clips_ops import (
    clips_for_track,
    new_clip_id,
    place_clips_at,
    set_track_clips,
    update_timeline_duration,
)
from podcast_mcp.engines.track_ids import slug_track_id
from podcast_mcp.engines.transcript_sync import rebuild_combined
from podcast_mcp.models import (
    ChapterMarker,
    Clip,
    EpisodeProject,
    SourceRecording,
    Track,
    TrackRole,
)
from podcast_mcp.models.episode import SegmentRef
from podcast_mcp.segments.model import SegmentFile
from podcast_mcp.util.change_summary import change_summary
from podcast_mcp.util.coded_error import CodedValueError

# A clip may run this far past its file's probed length (container rounding).
_DURATION_SLACK_SEC = 0.05


@dataclass(frozen=True)
class SegmentAudio:
    """One segment audio file after it was copied into the project and probed."""

    source_id: str
    path: str
    duration_sec: float
    sample_rate: int
    channels: int


def timeline_end(project: EpisodeProject) -> float:
    return max((clip.timeline_end for clip in project.clips), default=0.0)


def check_position(project: EpisodeProject, at: float) -> None:
    """Refuse a position that is not on the timeline: before 0, past its end or not a number."""
    end = timeline_end(project)
    if not math.isfinite(at) or at < 0 or at > end + 1e-6:
        raise CodedValueError(
            f"{at!r} s is not on the timeline, which runs from 0 to {end:g} s. "
            "Pick a time inside it.",
            code="segment_position_out_of_range",
        )


def _unique_track_id(project: EpisodeProject, preferred: str) -> str:
    base = slug_track_id(preferred)
    taken = {t.id for t in project.tracks}
    if base not in taken:
        return base
    i = 2
    while f"{base}_{i}" in taken:
        i += 1
    return f"{base}_{i}"


def map_lanes(project: EpisodeProject, segment: SegmentFile) -> dict[int, str]:
    """The track each segment lane lands on, creating the tracks that do not exist yet.

    Lane 0 of a segment whose role is not dialogue goes on the project's first track of that
    role, so an intro lands on the intro track the episode already has. Every other lane gets
    a track of its own, named for the segment, with the segment's role and level. A dialogue
    segment always gets its own track: it is not any speaker's voice.
    """
    lanes = sorted({clip.lane for clip in segment.clips})
    mapping: dict[int, str] = {}
    for lane in lanes:
        if lane == lanes[0] and segment.role is not TrackRole.DIALOGUE:
            existing = next((t for t in project.tracks if t.role is segment.role), None)
            if existing is not None:
                mapping[lane] = existing.id
                continue
        label = segment.name if lane == lanes[0] else f"{segment.name} {lane + 1}"
        track = Track(
            id=_unique_track_id(project, label),
            label=label,
            role=segment.role,
            speaker=label if segment.role is TrackRole.DIALOGUE else None,
            fader_db=segment.fader_db,
            timeline_empty=True,
        )
        project.tracks.append(track)
        mapping[lane] = track.id
    return mapping


def insert_segment(
    project: EpisodeProject,
    segment: SegmentFile,
    audio: Mapping[str, SegmentAudio],
    at: float,
    *,
    defaults: EffectiveConfig,
) -> dict:
    """Insert ``segment`` at timeline second ``at``, moving later content by its length.

    ``audio`` maps each media name of the segment to its copy in the project. Raises
    ``segment_position_out_of_range`` before anything changes.
    """
    check_position(project, at)
    for clip in segment.clips:
        copy = audio[clip.audio]
        if clip.duration_sec > copy.duration_sec + _DURATION_SLACK_SEC:
            raise CodedValueError(
                f"The audio {clip.audio} of segment {segment.name!r} is shorter than its layout "
                f"says ({copy.duration_sec:g} s, not {clip.duration_sec:g} s).",
                code="segment_media_invalid",
            )
    duration = segment.duration_sec
    for name, copy in audio.items():
        if project.source_by_id(copy.source_id) is None:
            project.sources.append(
                SourceRecording(
                    id=copy.source_id,
                    path=copy.path,
                    label=f"{segment.name} ({name})",
                    duration_sec=copy.duration_sec,
                    sample_rate=copy.sample_rate,
                    channels=copy.channels,
                )
            )
    lanes = map_lanes(project, segment)
    ref = SegmentRef(
        segment_id=segment.id, version=segment.version, content_sha256=segment.content_sha256
    )
    by_track: dict[str, list[Clip]] = {tid: [] for tid in dict.fromkeys(lanes.values())}
    for clip in segment.clips:
        track_id = lanes[clip.lane]
        by_track[track_id].append(
            Clip(
                id=new_clip_id(),
                track_id=track_id,
                source_id=audio[clip.audio].source_id,
                source_start=0.0,
                source_end=clip.duration_sec,
                timeline_start=clip.offset_sec,
                fade_in_ms=clip.fade_in_ms,
                fade_out_ms=clip.fade_out_ms,
                join_in_mode=clip.join_in_mode,
                segment_ref=ref,
            )
        )
    affected = ripple_track_ids(project, by_track)
    ripple_insert_clips(project, at, duration, affected, defaults=defaults)
    shift_review_anchors_for_insert(project, at, duration)
    for track_id, placed in by_track.items():
        set_track_clips(
            project, track_id, place_clips_at(clips_for_track(project, track_id), placed, at)
        )
    if segment.chapter_title:
        project.chapters.append(ChapterMarker(time=at, title=segment.chapter_title))
        project.chapters.sort(key=lambda chapter: chapter.time)
    update_timeline_duration(project)
    rebuild_combined(project, defaults=defaults)
    return change_summary(
        project,
        operation="insert_segment",
        affected_tracks=affected,
        segment_id=segment.id,
        segment_version=segment.version,
        at=at,
        duration_sec=duration,
        tracks={str(lane): track_id for lane, track_id in lanes.items()},
    )
