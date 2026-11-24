from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict


class ClipListing(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    tracks: dict[str, list[dict[str, Any]]]
    clip_count: int
    join_fade_limit_ms: int
    join_fade_limit_default_ms: int
