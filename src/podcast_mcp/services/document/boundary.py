from __future__ import annotations

import hashlib
import json
import math
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from podcast_mcp.config import load_defaults, mix_peak_ceiling_db
from podcast_mcp.edits.clips_ops import neighbour_clips, roll_join_limits, trim_edge_limits
from podcast_mcp.engines.ffmpeg import MIX_SEMANTICS_REV
from podcast_mcp.engines.play_audit import track_render_hash
from podcast_mcp.models import Clip, EditMode, EpisodeProject
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.tracks import recording_audio_path


class TrimBoundaryTarget(BaseModel):
    """A clip edge to trim. ``mode`` decides its limits: a gap trim also stops at the
    neighbouring clip on the timeline. The token is minted for one mode."""

    kind: Literal["trim"] = "trim"
    clip_id: str
    edge: Literal["in", "out"]
    mode: EditMode = EditMode.RIPPLE


class RollBoundaryTarget(BaseModel):
    kind: Literal["roll"] = "roll"
    left_clip_id: str
    right_clip_id: str


BoundaryTarget = Annotated[TrimBoundaryTarget | RollBoundaryTarget, Field(discriminator="kind")]


class TrimBoundaryEdit(TrimBoundaryTarget):
    source_sec: float = Field(allow_inf_nan=False)


class RollBoundaryEdit(RollBoundaryTarget):
    delta_sec: float = Field(allow_inf_nan=False)


BoundaryEdit = Annotated[TrimBoundaryEdit | RollBoundaryEdit, Field(discriminator="kind")]


class ClipGeometry(BaseModel):
    id: str
    source_start: float
    source_end: float
    timeline_start: float
    source_id: str | None

    @classmethod
    def from_clip(cls, clip: Clip) -> ClipGeometry:
        return cls(
            id=clip.id,
            source_start=clip.source_start,
            source_end=clip.source_end,
            timeline_start=clip.timeline_start,
            source_id=clip.source_id,
        )


class BoundaryPosition(BaseModel):
    source_sec: float
    timeline_sec: float


class BoundaryLimits(BaseModel):
    min: float
    max: float
    fine_step_sec: float = 0.001
    regular_step_sec: float = 0.01


class BoundaryContext(BaseModel):
    target: TrimBoundaryTarget | RollBoundaryTarget
    token: str
    track_id: str
    geometry: list[ClipGeometry]
    current: BoundaryPosition
    limits: BoundaryLimits


class BoundaryAudioWindow(BaseModel):
    url: str
    window_start_sec: float
    window_end_sec: float
    duration_sec: float
    seam_offset_sec: float


class BoundaryAudition(BaseModel):
    token: str
    actual_edit: TrimBoundaryEdit | RollBoundaryEdit
    current: BoundaryAudioWindow
    proposed: BoundaryAudioWindow


def boundary_context(
    project: EpisodeProject,
    target: TrimBoundaryTarget | RollBoundaryTarget,
    *,
    expected_geometry: list[ClipGeometry] | None = None,
) -> BoundaryContext:
    """Return legal bounds and an opaque digest for the exact heard track state.

    The optional expected geometry must match the visible clips before a dialog opens.
    A stale caller receives a conflict instead of silently editing new geometry.
    """
    from podcast_mcp.services.document_sync import DocumentConflictError

    if isinstance(target, RollBoundaryTarget):
        try:
            left, right, _, _ = neighbour_clips(project, target.left_clip_id, target.right_clip_id)
        except ValueError as exc:
            if expected_geometry is None:
                raise
            raise DocumentConflictError("boundary changed; reload its current position") from exc
        clips = [left, right]
        lo, hi = roll_join_limits(project, left.id, right.id)
        position = BoundaryPosition(source_sec=left.source_end, timeline_sec=left.timeline_end)
    else:
        clip = next((c for c in project.clips if c.id == target.clip_id), None)
        if clip is None:
            if expected_geometry is not None:
                raise DocumentConflictError("boundary changed; reload its current position")
            raise CodedValueError(f"unknown clip_id: {target.clip_id!r}", code="clip_not_found")
        lo, hi = trim_edge_limits(project, clip, target.edge, target.mode)
        clips = [clip]
        position = BoundaryPosition(
            source_sec=clip.source_start if target.edge == "in" else clip.source_end,
            timeline_sec=clip.timeline_start if target.edge == "in" else clip.timeline_end,
        )
    if not all(
        math.isfinite(value) for value in (lo, hi, position.source_sec, position.timeline_sec)
    ):
        raise ValueError("boundary bounds must be finite")
    if lo > hi:
        raise ValueError("boundary has no legal range")
    geometry = [ClipGeometry.from_clip(c) for c in clips]
    if expected_geometry is not None and geometry != expected_geometry:
        raise DocumentConflictError("boundary changed; reload its current position")
    track = project.track_by_id(clips[0].track_id)
    if track is None:
        raise CodedValueError("boundary track is missing", code="track_not_found")
    defaults = load_defaults()
    selected_media = []
    for source_id in dict.fromkeys(c.source_id for c in project.clips if c.track_id == track.id):
        path = recording_audio_path(project, track.id, source_id)
        try:
            stat = path.stat()
            media_revision = [
                stat.st_dev,
                stat.st_ino,
                stat.st_size,
                stat.st_mtime_ns,
                stat.st_ctime_ns,
            ]
        except OSError:
            media_revision = None
        selected_media.append(
            {"source_id": source_id, "path": str(path), "revision": media_revision}
        )
    revision = {
        "target": target.model_dump(),
        "geometry": [item.model_dump() for item in geometry],
        "limits": [lo, hi],
        "track_render": track_render_hash(project, track.id),
        "selected_media": selected_media,
        "selected_transcripts": [
            {
                "source_id": source_id,
                "transcript": transcript.model_dump(),
            }
            for source_id, transcript in project.selected_source_transcripts(track.id)
        ],
        "fader_db": track.fader_db,
        "muted": track.muted,
        "mix_semantics": MIX_SEMANTICS_REV,
        "peak_ceiling_db": mix_peak_ceiling_db(defaults),
        "render_defaults": defaults,
    }
    raw = json.dumps(revision, sort_keys=True, separators=(",", ":"), default=str)
    return BoundaryContext(
        target=target,
        token=hashlib.sha256(raw.encode()).hexdigest(),
        track_id=track.id,
        geometry=geometry,
        current=position,
        limits=BoundaryLimits(min=lo, max=hi),
    )


def assert_boundary_token(
    project: EpisodeProject,
    target: TrimBoundaryTarget | RollBoundaryTarget,
    expected_token: str,
) -> BoundaryContext:
    """Validate inside the saved-project mutation transaction before history is recorded."""
    from podcast_mcp.services.document_sync import DocumentConflictError

    context = boundary_context(project, target)
    if context.token != expected_token:
        raise DocumentConflictError("boundary preview is stale; reload and listen again")
    return context
