"""The suppression result TypedDicts match what the engines emit."""

import json
from typing import Literal, get_args, get_overloads, get_type_hints

import pytest

from podcast_mcp.services.document import (
    AnalysisService,
    SuppressBleedApplied,
    SuppressBleedPreview,
    SuppressLowAudibilityResult,
)
from podcast_mcp.services.document.suppress_results import SuppressBleedCandidate
from test_suppress_bleed_wire import (
    _build,
    _Low,
    _low_audibility_off,
    _synthetic_audio,
)

pytestmark = pytest.mark.unscoped_ok

_FIXTURES = (_low_audibility_off, _synthetic_audio)


def _shape(td: type) -> tuple[list[str], set[str], set[str]]:
    return list(td.__annotations__), set(td.__required_keys__), set(td.__optional_keys__)


@pytest.mark.parametrize(
    ("td", "keys"),
    [
        (
            SuppressBleedCandidate,
            [
                "track_id",
                "source_id",
                "word_index",
                "text",
                "start",
                "end",
                "audibility_status",
                "dominant_track",
                "already_suppressed",
            ],
        ),
        (SuppressBleedPreview, ["dry_run", "candidate_count", "candidates"]),
        (SuppressBleedApplied, ["dry_run", "applied", "suppressed_count", "candidates"]),
        (SuppressLowAudibilityResult, ["suppressed_count"]),
    ],
)
def test_typed_dict_keys_are_ordered_and_all_required(td, keys):
    names, required, optional = _shape(td)
    assert names == keys
    assert required == set(keys)
    assert optional == set()


def test_preview_matches_the_engine(tmp_path):
    result = AnalysisService(_build(tmp_path)).preview_suppress_bleed()
    names, required, _ = _shape(SuppressBleedPreview)
    assert list(result) == names
    assert set(result) == required
    assert result["candidates"]
    for row in result["candidates"]:
        assert list(row) == list(SuppressBleedCandidate.__annotations__)
    assert type(result) is dict
    assert json.loads(json.dumps(result)) == result


def test_applied_matches_the_engine(tmp_path):
    result = AnalysisService(_build(tmp_path)).suppress_bleed()
    names, required, _ = _shape(SuppressBleedApplied)
    assert list(result) == names
    assert set(result) == required
    assert result["dry_run"] is False
    assert result["applied"] is True
    assert result["candidates"]
    for row in result["candidates"]:
        assert list(row) == list(SuppressBleedCandidate.__annotations__)
    assert type(result) is dict
    assert json.loads(json.dumps(result)) == result


def test_literal_fields_hold_the_emitted_values(tmp_path):
    hints = get_type_hints(SuppressBleedPreview)
    assert get_args(hints["dry_run"]) == (True,)
    applied = get_type_hints(SuppressBleedApplied)
    assert get_args(applied["dry_run"]) == (False,)
    assert get_args(applied["applied"]) == (True,)
    ws = _build(tmp_path)
    svc = AnalysisService(ws)
    assert svc.suppress_bleed(apply=False)["dry_run"] is True


def test_low_audibility_matches_the_engine(tmp_path):
    _Low.on = True
    result = AnalysisService(_build(tmp_path)).suppress_low_audibility()
    names, required, _ = _shape(SuppressLowAudibilityResult)
    assert list(result) == names
    assert set(result) == required
    assert type(result) is dict
    assert type(result["suppressed_count"]) is int
    assert json.dumps(result) == json.dumps({"suppressed_count": result["suppressed_count"]})


def test_suppress_bleed_overloads_resolve_on_apply():
    overloads = get_overloads(AnalysisService.suppress_bleed)
    assert len(overloads) == 2
    by_return = {get_type_hints(fn)["return"]: get_type_hints(fn)["apply"] for fn in overloads}
    assert by_return == {
        SuppressBleedPreview: Literal[False],
        SuppressBleedApplied: Literal[True],
    }
    preview, applied = (
        next(fn for fn in overloads if get_type_hints(fn)["return"] is td)
        for td in (SuppressBleedPreview, SuppressBleedApplied)
    )
    assert "apply" not in (preview.__kwdefaults__ or {})
    assert applied.__kwdefaults__["apply"] is True
    assert get_type_hints(AnalysisService.preview_suppress_bleed)["return"] is SuppressBleedPreview
    assert (
        get_type_hints(AnalysisService.suppress_low_audibility)["return"]
        is SuppressLowAudibilityResult
    )
