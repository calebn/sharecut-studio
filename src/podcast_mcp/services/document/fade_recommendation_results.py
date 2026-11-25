from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict


class AppliedFadeUpdates(BaseModel):
    """Count of clip fade updates applied from a recommendation list."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    applied_fade_updates: int


class AppliedFadeRecommendations(AppliedFadeUpdates):
    """Fade updates applied for a track, with the number of recommendations found."""

    recommendation_count: int


def applied_fade_updates(out: Mapping[str, Any]) -> AppliedFadeUpdates:
    """Validate the engine's apply result."""
    return AppliedFadeUpdates.model_validate(out)


def applied_fade_recommendations(
    result: AppliedFadeUpdates, recommendation_count: int
) -> AppliedFadeRecommendations:
    """Pair an apply result with the recommendation count."""
    return AppliedFadeRecommendations(
        applied_fade_updates=result.applied_fade_updates,
        recommendation_count=recommendation_count,
    )
