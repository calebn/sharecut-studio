from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _SegmentInsertResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, serialize_by_alias=True)


class ChapterMove(_SegmentInsertResult):
    title: str
    from_sec: float = Field(serialization_alias="from")
    to: float


class CommentMove(_SegmentInsertResult):
    id: str
    from_sec: float = Field(serialization_alias="from")
    to: float


class _SegmentInsertReport(_SegmentInsertResult):
    """The head every insert report starts with; ``model_dump()`` is what the CLI and MCP print."""

    dry_run: bool
    segment_id: str
    segment_version: int
    at: float
    duration_sec: float


class SegmentInsertPreview(_SegmentInsertReport):
    """What an insert would do. Nothing was written."""

    dry_run: Literal[True] = True
    timeline_duration_before_sec: float
    timeline_duration_after_sec: float
    clips_moved: int
    clips_added: int
    clips_from_segment: int
    chapters_moved: list[ChapterMove]
    chapter_added: str | None
    comments_moved: list[CommentMove]
    pending_edits_moved: int
    tracks_added: list[str]
    tracks: dict[str, str]


class SegmentInsertApplied(_SegmentInsertReport):
    """What an insert did."""

    dry_run: Literal[False] = False
    operation: Literal["insert_segment"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    tracks: dict[str, str]

    def journal(self) -> Mapping[str, Any]:
        """The ``InsertSegment`` result as the journal stores it: the change, then the segment."""
        head = set(_SegmentInsertReport.model_fields)
        change = self.model_dump(exclude=head | {"tracks"})
        segment = self.model_dump(include=head - {"dry_run"})
        return {**change, **segment, "tracks": self.tracks}
