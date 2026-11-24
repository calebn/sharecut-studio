"""A pending pad's room-tone pick, bound to its edit so every preview and approve play one fill (#3600).

A pad's fill used to be picked when the cut applied. The pick ranks the pool's samples away
from those nearby pads already play and seeds its tiles from the pad's timeline position, so
the same cut sounded different depending on which other cuts had applied before it, and
differently from the preview that was auditioned. The binding records the pick on the
pending edit (``EditDecision.bound_pad``) when it is proposed; apply and preview read it.

A binding is used only while it still answers the question the apply asks: the edit's
geometry is unchanged, the lane's seam and request are the same, the room-tone inputs it read
(pool, bed, synthesis parameters, the recording's file) are the same, and its own-audio sample
is not source that another pending cut still plays. Anything else picks fresh. Picks are
bound in ``cut_application.bind_pending_pad_picks``.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Any

from podcast_mcp.engines.room_tone import (
    OwnQuietSample,
    RecordedBedSample,
    Sample,
    room_tone_bed,
    room_tone_bed_digest,
    room_tone_pool_digest,
)
from podcast_mcp.engines.room_tone_synth import SynthSample, room_tone_synth_digest
from podcast_mcp.models.episode import BoundPad, BoundPadLane
from podcast_mcp.util.project_state import file_revision
from podcast_mcp.util.tracks import track_audio_path
from podcast_mcp.util.workspace_paths import resolve_under_workspace

if TYPE_CHECKING:
    from podcast_mcp.models import EditDecision, EpisodeProject

Span = tuple[float, float]
PadSelection = OwnQuietSample | RecordedBedSample
_EPS = 1e-6
_GEOMETRY_FIELDS = (
    "track_id",
    "type",
    "start",
    "end",
    "timebase",
    "source_id",
    "scope",
    "replace_gap_sec",
    "track_ids",
    "reason",
    "source_timeline_span",
)


@dataclass(frozen=True)
class PadSeam:
    """What one lane's pick answered: the seam, the sample length asked for, and the tile seed."""

    near_sec: float
    near_source_id: str | None
    request_sec: float
    seed_sec: float


def geometry_key(edit: EditDecision) -> str:
    """Digest of the edit fields a pad's pick depends on; a binding made for another one is stale."""
    fields = edit.model_dump(mode="json", include=set(_GEOMETRY_FIELDS))
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()[:16]


def lane_digest(project: EpisodeProject, track_id: str) -> str:
    """What a lane's pick read: its pool, its bed, the synthesis parameters and the recording."""
    try:
        recording: object = list(file_revision(track_audio_path(project, track_id)))
    except (OSError, ValueError, KeyError):
        recording = None
    parts = [
        room_tone_pool_digest(project, track_id),
        room_tone_bed_digest(project, track_id),
        room_tone_synth_digest(),
        recording,
    ]
    return hashlib.sha256(json.dumps(parts).encode()).hexdigest()[:16]


def bound_lane(
    project: EpisodeProject,
    track_id: str,
    selection: PadSelection,
    seam: PadSeam,
) -> BoundPadLane:
    """``selection``, picked for ``seam``, as the record the edit keeps."""

    def lane(**sample: Any) -> BoundPadLane:
        return BoundPadLane(
            near_sec=seam.near_sec,
            near_source_id=seam.near_source_id,
            request_sec=seam.request_sec,
            seed_sec=seam.seed_sec,
            digest=lane_digest(project, track_id),
            **sample,
        )

    if isinstance(selection, OwnQuietSample):
        own = selection.sample
        return lane(
            kind="own",
            start=own.start,
            end=own.end,
            rms_db=own.rms_db,
            speech_prob=own.speech_prob,
            bed_failure=selection.bed_failure,
            bed_rejected_checks=list(selection.bed_rejected_checks),
        )
    if isinstance(selection, SynthSample):
        return lane(
            kind="synth",
            start=selection.start,
            end=selection.end,
            source_id=selection.source_id,
            rel_path=selection.rel_path,
            file_sec=selection.duration_sec,
        )
    return lane(kind="bed", start=selection.start, end=selection.end, source_id=selection.source_id)


def usable_lanes(edit: EditDecision) -> Mapping[str, BoundPadLane]:
    """The edit's bound lanes while its geometry is the one they were bound for; else none."""
    bound = edit.bound_pad
    return bound.lanes if bound is not None and bound.geometry == geometry_key(edit) else {}


def bind(edit: EditDecision, lanes: Mapping[str, BoundPadLane]) -> BoundPad | None:
    """The binding for ``edit`` with ``lanes``; None when no lane has a sample to keep."""
    return BoundPad(geometry=geometry_key(edit), lanes=dict(lanes)) if lanes else None


def reusable_selection(
    project: EpisodeProject,
    track_id: str,
    lane: BoundPadLane,
    seam: PadSeam,
    avoid: Sequence[Span],
) -> PadSelection | None:
    """The bound sample, rebuilt, when ``lane`` still answers what this apply asks; else None."""
    if (
        abs(lane.near_sec - seam.near_sec) > _EPS
        or lane.near_source_id != seam.near_source_id
        or abs(lane.request_sec - seam.request_sec) > _EPS
        or lane.digest != lane_digest(project, track_id)
    ):
        return None
    if lane.kind == "own":
        if lane.rms_db is None or any(a < lane.end and lane.start < b for a, b in avoid):
            return None
        return OwnQuietSample(
            Sample(lane.start, lane.end, lane.rms_db, lane.speech_prob),
            bed_failure=lane.bed_failure,
            bed_rejected_checks=tuple(lane.bed_rejected_checks),
        )
    if lane.kind == "bed":
        bed = room_tone_bed(project, track_id)
        if (
            not isinstance(bed, RecordedBedSample)
            or bed.source_id != lane.source_id
            or abs(bed.start - lane.start) > _EPS
            or lane.end > bed.end + _EPS
        ):
            return None
        return replace(bed, end=lane.end)
    if lane.source_id is None or lane.rel_path is None or lane.file_sec is None:
        return None
    try:
        file = resolve_under_workspace(project, lane.rel_path)
    except (OSError, ValueError):
        return None
    if not file.is_file():
        return None
    return SynthSample(lane.start, lane.end, lane.source_id, file, lane.rel_path, lane.file_sec)
