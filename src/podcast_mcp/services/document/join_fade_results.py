from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class FadeJoinsResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["fade_joins"]
    join_count: int
    fade_ms: int | None
    requested_fade_ms: int | None
    cap_ms: int
    kept_longer_joins: int
    dry_run: bool
    affected_tracks: list[str]


class CrossfadeJoinsResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    operation: Literal["crossfade_joins"]
    join_count: int
    fade_ms: int
    requested_fade_ms: int | None
    clamped_joins: int
    dry_run: bool
    affected_tracks: list[str]
