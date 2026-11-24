from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class SetClipFadeResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["set_clip_fade"]
    affected_tracks: list[str]
    clip_count: int
    timeline_duration_sec: float | None
    fade_in_ms: int
    fade_out_ms: int
    clamped: bool
