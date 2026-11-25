from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict


class StripSilenceResult(BaseModel):
    """Outcome of rebuilding one track from its speech islands."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    track_id: str
    silence_intervals: int
    clips_created: int
    removed_sec: float
    timeline_duration_sec: float


def strip_silence_result(out: Mapping[str, Any]) -> StripSilenceResult:
    """Validate the engine's report."""
    return StripSilenceResult.model_validate(out)
