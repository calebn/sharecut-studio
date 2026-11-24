from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class DuplicateSegmentResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["duplicate_segment"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None


class PasteSegmentResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["paste_segment"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    insert_at: float | int
    duration: float | int
    mode: Literal["ripple", "gap"]
