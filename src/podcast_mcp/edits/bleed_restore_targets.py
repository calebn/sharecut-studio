from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from podcast_mcp.engines.session_timeline import clip_timeline_overlap_to_source
from podcast_mcp.models import Clip, EpisodeProject
from podcast_mcp.models.episode import ClipBleedRestore, SourceSpan
from podcast_mcp.util.coded_error import CodedError
from podcast_mcp.util.intervals import merge_intervals, subtract_intervals

BleedRegionKind = Literal["late_gate", "bleed_mute:off_speaker"]
OccurrenceKind = Literal["explicit", "implicit"]
MAPPING_REVISION: Literal["editorial-source-v1"] = "editorial-source-v1"


class BleedRestoreChangedError(CodedError, ValueError):
    """The selected automatic reduction must be inspected again."""

    code = "bleed_restore_changed"


class BleedRestoreTarget(BaseModel):
    model_config = {"extra": "forbid", "frozen": True}

    track_id: str
    occurrence_kind: OccurrenceKind
    clip: Clip
    kind: BleedRegionKind
    region: SourceSpan
    mapping_revision: Literal["editorial-source-v1"] = MAPPING_REVISION
    media_seal: str
    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    dependencies_digest: str
    plan_digest: str
    expected_head_id: str = Field(min_length=1, strict=True)

    @field_validator("clip", "region")
    @classmethod
    def _detach_snapshot(cls, value: Any) -> Any:
        return value.model_copy(deep=True)


def state_digest(state: Any) -> str:
    return hashlib.sha256(
        json.dumps(state, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def selected_occurrence(
    project: EpisodeProject, clip_id: str, track_id: str
) -> tuple[Clip, OccurrenceKind]:
    track = project.track_by_id(track_id)
    if track is None:
        raise BleedRestoreChangedError("The selected lane changed. Inspect the clip again.")
    matches = [clip for clip in project.clips if clip.id == clip_id]
    if len(matches) == 1 and matches[0].track_id == track_id:
        return matches[0].model_copy(deep=True), "explicit"
    if (
        not matches
        and clip_id == f"clip_{track_id}_full"
        and track.media is not None
        and track.media.path
        and track.media.duration_sec is not None
        and track.media.duration_sec > 0
        and not track.timeline_empty
        and not any(clip.track_id == track_id for clip in project.clips)
    ):
        return (
            Clip(
                id=clip_id,
                track_id=track_id,
                source_start=0,
                source_end=track.media.duration_sec,
                timeline_start=0,
            ),
            "implicit",
        )
    raise BleedRestoreChangedError("The selected clip changed. Inspect the clip again.")


def late_source_regions(clip: Clip, spans: Iterable[tuple[float, float]]) -> list[SourceSpan]:
    mapped = []
    for start, end in spans:
        source = clip_timeline_overlap_to_source(clip, start, end)
        if source is not None:
            mapped.append(source)
    return [SourceSpan(start_s=start, end_s=end) for start, end in mapped]


def region_fragments(
    clip: Clip, region: SourceSpan, saved: Iterable[SourceSpan]
) -> tuple[list[SourceSpan], list[SourceSpan]]:
    start = max(clip.source_start, region.start_s)
    end = min(clip.source_end, region.end_s)
    if end <= start:
        return [], []
    coverage = merge_intervals(
        (max(start, span.start_s), min(end, span.end_s))
        for span in saved
        if min(end, span.end_s) > max(start, span.start_s)
    )
    remaining = subtract_intervals([(start, end)], coverage)
    return (
        [SourceSpan(start_s=lo, end_s=hi) for lo, hi in coverage],
        [SourceSpan(start_s=lo, end_s=hi) for lo, hi in remaining],
    )


def merged_restore_choice(clip: Clip, source_sha256: str, region: SourceSpan) -> ClipBleedRestore:
    previous = clip.bleed_restore
    regions = (
        previous.regions if previous is not None and previous.source_sha256 == source_sha256 else []
    )
    return ClipBleedRestore(
        source_sha256=source_sha256,
        regions=[*regions, region.model_copy(deep=True)],
    )
