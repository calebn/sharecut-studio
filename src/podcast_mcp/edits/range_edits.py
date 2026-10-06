from __future__ import annotations

import hashlib
import json
from typing import Any, Literal, TypedDict
from uuid import uuid4

from podcast_mcp.edits.clips_ops import punch_timeline_range_from_clips, set_track_clips
from podcast_mcp.edits.edit_log import archive_decision
from podcast_mcp.edits.mute_regions import add_source_mute
from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.engines.session_timeline import clip_timeline_overlap_to_source
from podcast_mcp.models import Clip, EditDecision, EditDecisionType, EpisodeProject
from podcast_mcp.models.episode import ExactRangeTarget, RangeInterval

RangeAction = Literal["cut", "mute"]


class RangeEditResult(TypedDict):
    action_id: str
    proposed: bool
    edit: dict[str, Any]


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


def apply_range(project: EpisodeProject, edit: EditDecision) -> None:
    apply_ranges(project, [edit])


def apply_ranges(project: EpisodeProject, edits: list[EditDecision]) -> None:
    plans: list[tuple[EditDecision, ExactRangeTarget]] = []
    for edit in edits:
        if edit.exact_range is None:
            raise ValueError("exact range target required")
        target = resolve_range(project, edit.exact_range)
        if not target.clips:
            raise ValueError("No audible media in this range")
        plans.append((edit, target))
    if any(edit.type == EditDecisionType.REMOVE for edit, _target in plans):
        from podcast_mcp.engines.timeline_render import timeline_duration_sec

        project.timeline.duration_sec = max(
            project.timeline.duration_sec or 0.0,
            timeline_duration_sec(project),
            max(c.timeline_end for _edit, target in plans for c in target.clips),
        )
    operations: dict[str, list[tuple[EditDecisionType, RangeInterval]]] = {}
    track_ids: set[str] = set()
    for edit, target in plans:
        track_ids.update(c.track_id for c in target.clips)
        for clip in target.clips:
            if not any(c.id == clip.id for c in project.clips):
                project.clips.append(clip.model_copy(deep=True))
            operations.setdefault(clip.id, []).extend(
                (edit.type, interval) for interval in target.intervals
            )
    for tid in sorted(track_ids):
        replacements: list[Clip] = []
        for original in project.clips:
            if original.track_id != tid:
                continue
            actions = operations.get(original.id)
            if not actions:
                replacements.append(original)
                continue
            clip = original.model_copy(deep=True)
            cuts: list[tuple[float, float]] = []
            for action, interval in actions:
                a = max(interval.start, clip.timeline_start)
                b = min(interval.end, clip.timeline_end)
                if b <= a:
                    continue
                if action == EditDecisionType.MUTE:
                    source_span = clip_timeline_overlap_to_source(clip, a, b)
                    if source_span is not None:
                        add_source_mute(clip, *source_span)
                else:
                    cuts.append((a, b))
            if not cuts:
                replacements.append(clip)
                continue
            remaining = [clip]
            for start, end in sorted(cuts):
                remaining = punch_timeline_range_from_clips(remaining, start, end)
            replacements.extend(remaining)
        set_track_clips(project, tid, replacements)
        if not replacements:
            track = project.track_by_id(tid)
            if track is not None:
                track.timeline_empty = True
    rebuild_combined(project)
    for edit, target in plans:
        archive_decision(
            project,
            edit,
            operation="edit_selected_range",
            timeline_start=target.intervals[0].start,
            timeline_end=target.intervals[-1].end,
            track_ids=target.track_ids,
            params={
                "exact_range": target.model_dump(mode="json"),
                "action_id": edit.id,
                "action": "mute" if edit.type == EditDecisionType.MUTE else "cut",
            },
        )


def edit_selected_range(
    project: EpisodeProject,
    target: ExactRangeTarget,
    action: RangeAction,
    *,
    propose: bool,
    reason: str,
    action_id: str,
    author: str | None = None,
) -> RangeEditResult:
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
        author=author,
        exact_range=target,
    )
    if propose:
        project.edit_decisions.append(edit)
    else:
        apply_range(project, edit)
    return {"action_id": edit.id, "proposed": propose, "edit": edit.model_dump(mode="json")}
