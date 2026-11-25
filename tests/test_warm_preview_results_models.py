from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from podcast_mcp.services.document.warm_preview_results import (
    WarmPreviewResult,
    warm_preview_result,
)


def test_field_order() -> None:
    assert list(WarmPreviewResult.model_fields) == ["trim_db", "sides"]


def test_frozen() -> None:
    result = WarmPreviewResult(trim_db=-1.0, sides={})
    with pytest.raises(ValidationError):
        result.trim_db = 0.0  # type: ignore[misc]


def test_extra_forbidden() -> None:
    with pytest.raises(ValidationError):
        WarmPreviewResult.model_validate({"trim_db": 0.0, "sides": {}, "other": 1})


@pytest.mark.parametrize(
    "payload",
    [
        {"trim_db": 0.0, "sides": {"current": "done"}},
        {"trim_db": 0.0, "sides": {"middle": "ready"}},
        {"sides": {}},
        {"trim_db": 0.0},
        {"trim_db": "loud", "sides": {}},
    ],
)
def test_invalid_payloads_are_rejected(payload: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        WarmPreviewResult.model_validate(payload)


@pytest.mark.parametrize(
    ("trim", "sides", "text"),
    [
        (0.0, {}, '{"trim_db":0.0,"sides":{}}'),
        (-2.25, {"current": "ready"}, '{"trim_db":-2.25,"sides":{"current":"ready"}}'),
        (
            -6.02,
            {"current": "ready", "suggested": "unavailable", "ab": "failed"},
            '{"trim_db":-6.02,"sides":{"current":"ready","suggested":"unavailable","ab":"failed"}}',
        ),
    ],
)
def test_dump_round_trip(trim: float, sides: dict[str, str], text: str) -> None:
    result = warm_preview_result(trim, sides)
    dumped = result.model_dump()
    assert type(dumped["trim_db"]) is float
    assert json.dumps(dumped, separators=(",", ":")) == text
    assert WarmPreviewResult.model_validate(dumped) == result


def test_builder_rejects_an_unknown_status() -> None:
    with pytest.raises(ValidationError):
        warm_preview_result(0.0, {"current": "nope"})
