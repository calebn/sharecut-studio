from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class _SegmentInsertResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ChapterMove(_SegmentInsertResult):
    title: str
    from_sec: float = Field(serialization_alias="from")
    to: float


class CommentMove(_SegmentInsertResult):
    id: str
    from_sec: float = Field(serialization_alias="from")
    to: float


class SegmentInsertPreview(_SegmentInsertResult):
    """What an insert would do. Nothing was written; ``wire()`` is what the CLI and MCP print."""

    dry_run: Literal[True] = True
    segment_id: str
    segment_version: int
    at: float
    duration_sec: float
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

    def wire(self) -> Mapping[str, Any]:
        return self.model_dump(by_alias=True)


class SegmentInsertApplied(_SegmentInsertResult):
    """What an insert did, in the order the ``InsertSegment`` journal stores it.

    ``wire()`` is what the CLI and MCP print: ``dry_run`` false and the segment first.
    """

    operation: Literal["insert_segment"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    segment_id: str
    segment_version: int
    at: float
    duration_sec: float
    tracks: dict[str, str]

    def wire(self) -> Mapping[str, Any]:
        change = self.model_dump()
        segment = {
            key: change.pop(key) for key in ("segment_id", "segment_version", "at", "duration_sec")
        }
        return {"dry_run": False, **segment, **change}
