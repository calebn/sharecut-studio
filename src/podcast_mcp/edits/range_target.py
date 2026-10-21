"""Exact-range target: snapshot the geometry and media seals a range edit was made against, and
check they still hold (the cut modules below cut_application resolve a range from here)."""

from __future__ import annotations

import hashlib
import json

from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
)
from podcast_mcp.models.episode import ExactRangeTarget, RangeInterval
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.project_state import file_revision
from podcast_mcp.util.tracks import track_audio_path


class RangeChangedError(CodedError, ValueError):
    """The selected occurrences changed; the whole action needs reselection."""

    code = "range_changed"


def range_media_seal(project: EpisodeProject, track_id: str) -> str:

    track = project.track_by_id(track_id)
    if track is None:
        raise RangeChangedError("Selected tracks changed. Select the range again.")
    one_clip_per_source = {c.source_id: c for c in project.clips if c.track_id == track_id}
    clips: list[Clip | None] = list(one_clip_per_source.values())
    identities = []
    for clip in clips or [None]:
        try:
            path = (
                resolve_clip_audio_path(project, track, clip)
                if clip
                else track_audio_path(project, track_id)
            )
            try:
                revision = file_revision(path)
            except OSError:
                revision = None
            identities.append((str(path), revision))
        except (ValueError, OSError):
            identities.append((str(track.media), None))
    raw = json.dumps(sorted(set(identities), key=str), sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def range_geometry(
    project: EpisodeProject, intervals: list[RangeInterval], track_ids: list[str]
) -> list[Clip]:
    if any(project.track_by_id(t) is None for t in track_ids):
        raise RangeChangedError("Selected tracks changed. Select the range again.")
    clips = list(project.clips)
    for tid in track_ids:
        track = project.track_by_id(tid)
        if (
            track
            and track.media
            and not track.timeline_empty
            and not any(c.track_id == tid for c in clips)
        ):
            duration = track.media.duration_sec
            if duration is not None and duration > 0:
                clips.append(
                    Clip(
                        id=f"clip_{tid}_full",
                        track_id=tid,
                        source_start=0,
                        source_end=duration,
                        timeline_start=0,
                    )
                )
    return sorted(
        (
            c.model_copy(deep=True)
            for c in clips
            if c.track_id in track_ids
            and any(c.timeline_start < r.end and c.timeline_end > r.start for r in intervals)
        ),
        key=lambda c: c.id,
    )


def resolve_range(project: EpisodeProject, target: ExactRangeTarget) -> ExactRangeTarget:
    for tid in target.track_ids:
        track = project.track_by_id(tid)
        if (
            track
            and track.media
            and not track.timeline_empty
            and track.media.duration_sec is None
            and not any(c.track_id == tid for c in project.clips)
        ):
            raise RangeChangedError(
                "Selected lane duration is unavailable. Select lanes with known media bounds."
            )
    actual = range_geometry(project, target.intervals, target.track_ids)
    if actual != sorted(target.clips, key=lambda c: c.id) or target.media_seals != {
        t: range_media_seal(project, t) for t in target.track_ids
    }:
        raise RangeChangedError("Selected audio changed. Select the range again.")
    return target.model_copy(update={"clips": actual}, deep=True)


def range_is_current(project: EpisodeProject, target: ExactRangeTarget) -> bool:
    try:
        resolve_range(project, target)
    except RangeChangedError:
        return False
    return True


def build_range_target(
    project: EpisodeProject, intervals: list[RangeInterval], track_ids: list[str]
) -> ExactRangeTarget:
    """Snapshot the existing geometry and file-revision seals for an exact edit."""
    return ExactRangeTarget(
        intervals=intervals,
        track_ids=track_ids,
        clips=range_geometry(project, intervals, track_ids),
        media_seals={tid: range_media_seal(project, tid) for tid in track_ids},
    )
