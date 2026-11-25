from __future__ import annotations

import pytest
from pydantic import ValidationError

from podcast_mcp.services.document import AppliedFadeRecommendations, AppliedFadeUpdates
from podcast_mcp.services.document.fade_recommendation_results import (
    applied_fade_recommendations,
    applied_fade_updates,
)


def test_field_order() -> None:
    assert list(AppliedFadeUpdates.model_fields) == ["applied_fade_updates"]
    assert list(AppliedFadeRecommendations.model_fields) == [
        "applied_fade_updates",
        "recommendation_count",
    ]


def test_recommendations_is_updates() -> None:
    assert issubclass(AppliedFadeRecommendations, AppliedFadeUpdates)


def test_frozen() -> None:
    model = AppliedFadeUpdates(applied_fade_updates=1)
    with pytest.raises(ValidationError):
        model.applied_fade_updates = 2


def test_extra_forbidden() -> None:
    with pytest.raises(ValidationError):
        AppliedFadeUpdates.model_validate({"applied_fade_updates": 1, "x": 1})
    with pytest.raises(ValidationError):
        AppliedFadeRecommendations.model_validate({"applied_fade_updates": 1})


def test_ints_only() -> None:
    with pytest.raises(ValidationError):
        AppliedFadeUpdates.model_validate({"applied_fade_updates": "many"})


def test_builders_and_dump_order() -> None:
    updates = applied_fade_updates({"applied_fade_updates": 3})
    assert updates.model_dump() == {"applied_fade_updates": 3}
    built = applied_fade_recommendations(updates, 5)
    dumped = built.model_dump()
    assert dumped == {"applied_fade_updates": 3, "recommendation_count": 5}
    assert list(dumped) == ["applied_fade_updates", "recommendation_count"]


def test_builder_rejects_drifted_engine_dict() -> None:
    with pytest.raises(ValidationError):
        applied_fade_updates({"applied_fade_updates": 1, "extra": 2})
