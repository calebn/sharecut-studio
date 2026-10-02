"""Exact timeline occurrences for selected-track punch cuts and local mutes."""

from __future__ import annotations

import hashlib
import json
from typing import Literal
from uuid import uuid4

from podcast_mcp.edits.clips_ops import new_clip_id, set_track_clips
from podcast_mcp.edits.edit_log import archive_decision
from podcast_mcp.edits.mute_regions import add_source_mute, intersect_mute_regions
from podcast_mcp.edits.ranges import subtract_ranges_from_intervals
from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.models import Clip, EditDecision, EditDecisionType, EpisodeProject
from podcast_mcp.models.episode import ExactRangeTarget, RangeInterval

RangeAction = Literal["cut", "mute"]


class RangeChangedError(ValueError):
    """The selected occurrences changed; the whole action needs reselection."""


def range_media_seal(project: EpisodeProject, track_id: str) -> str:
    from podcast_mcp.engines.timeline_render import resolve_clip_audio_path
    from podcast_mcp.util.project_state import file_revision
    from podcast_mcp.util.tracks import track_audio_path

    track = project.track_by_id(track_id)
    if track is None:
        raise RangeChangedError("Selected tracks changed. Select the range again.")
    clips: list[Clip | None] = [c for c in project.clips if c.track_id == track_id]
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


def apply_range(project: EpisodeProject, edit: EditDecision) -> None:
    target = edit.exact_range
    if target is None:
        raise ValueError("exact range target required")
    target = resolve_range(project, target)
    if not target.clips:
        raise ValueError("No audible media in this range")
    for clip in target.clips:
        if not any(c.id == clip.id for c in project.clips):
            project.clips.append(clip.model_copy(deep=True))
    spans = [(r.start, r.end) for r in target.intervals]
    selected_ids = {c.id for c in target.clips}
    for tid in target.track_ids:
        replacements: list[Clip] = []
        for clip in project.clips:
            if clip.track_id != tid:
                continue
            if clip.id not in selected_ids:
                replacements.append(clip)
                continue
            if edit.type == EditDecisionType.MUTE:
                for start, end in spans:
                    a, b = max(start, clip.timeline_start), min(end, clip.timeline_end)
                    if b > a:
                        add_source_mute(
                            clip,
                            clip.source_start + a - clip.timeline_start,
                            clip.source_start + b - clip.timeline_start,
                        )
                replacements.append(clip)
                continue
            remaining = subtract_ranges_from_intervals(
                [(clip.timeline_start, clip.timeline_end)], spans
            )
            for start, end in remaining:
                src_start = clip.source_start + start - clip.timeline_start
                src_end = clip.source_start + end - clip.timeline_start
                replacements.append(
                    clip.model_copy(
                        update={
                            "id": new_clip_id(),
                            "timeline_start": start,
                            "source_start": src_start,
                            "source_end": src_end,
                            "fade_in_ms": clip.fade_in_ms if start == clip.timeline_start else 0,
                            "fade_out_ms": clip.fade_out_ms if end == clip.timeline_end else 0,
                            "mute_regions": intersect_mute_regions(
                                clip.mute_regions, src_start, src_end
                            ),
                        },
                        deep=True,
                    )
                )
        set_track_clips(project, tid, replacements)
        if not replacements:
            track = project.track_by_id(tid)
            if track is not None:
                track.timeline_empty = True
    rebuild_combined(project)
    archive_decision(
        project,
        edit,
        operation="edit_selected_range",
        timeline_start=target.intervals[0].start,
        timeline_end=target.intervals[-1].end,
        track_ids=target.track_ids,
        params={"exact_range": target.model_dump(mode="json"), "action_id": edit.id},
    )


def edit_selected_range(
    project: EpisodeProject,
    target: ExactRangeTarget,
    action: RangeAction,
    *,
    propose: bool,
    reason: str,
    action_id: str,
) -> dict:
    target = resolve_range(project, target)
    if not target.clips:
        raise ValueError("No audible media in this range")
    edit = EditDecision(
        id=action_id or f"range_{uuid4().hex}",
        track_id="",
        track_ids=target.track_ids,
        type=EditDecisionType.REMOVE if action == "cut" else EditDecisionType.MUTE,
        start=target.intervals[0].start,
        end=target.intervals[-1].end,
        timebase="timeline",
        scope="selected_tracks",
        review_required=propose,
        applied=False,
        reason=reason,
        exact_range=target,
    )
    if propose:
        project.edit_decisions.append(edit)
    else:
        apply_range(project, edit)
    return {"action_id": edit.id, "proposed": propose, "edit": edit.model_dump(mode="json")}
