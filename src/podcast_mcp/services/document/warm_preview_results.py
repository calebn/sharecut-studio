from __future__ import annotations

from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel, ConfigDict

PreviewSide = Literal["current", "suggested", "ab"]
PreviewSideStatus = Literal["ready", "unavailable", "failed"]


class WarmPreviewResult(BaseModel):
    """The mix trim a warm measured and the status of each side it pre-rendered."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    trim_db: float
    sides: dict[PreviewSide, PreviewSideStatus]


def warm_preview_result(trim_db: float, sides: Mapping[str, str]) -> WarmPreviewResult:
    """Validate a warm's trim and per-side statuses."""
    return WarmPreviewResult.model_validate({"trim_db": trim_db, "sides": dict(sides)})
