from typing import Literal

from pydantic import BaseModel, ConfigDict


class PadSample(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    track_id: str
    source_id: str | None
    source_start: float
    source_end: float


class FillRoomToneApplied(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["fill_with_room_tone"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    pad_samples: list[PadSample]


class FillRoomToneUnchanged(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["fill_with_room_tone"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    pad_samples: list[PadSample]
    unchanged: Literal[True]
