from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class FeedFieldPinResult(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    key: str
    pinned: bool
