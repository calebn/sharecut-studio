from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class InsertGapResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["insert_gap"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    at_time: float | int
    duration_sec: float | int


class MoveSegmentResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["move_segment"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    source_start: float | int
    source_end: float | int
    insert_at: float | int


class MoveClipsResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["move_clips"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    clip_ids: list[str]
