"""The inaudible-cut TypedDicts describe the engine's wire dicts exactly."""

import json
from typing import Any, Literal, get_args, get_origin, get_type_hints
from unittest.mock import patch

import pytest

import test_inaudible_snap_wire as wire
from podcast_mcp.edits.inaudible_cuts import CutMode
from podcast_mcp.edits.silence_islands import SilenceIsland
from podcast_mcp.services.document import AnalysisService
from podcast_mcp.services.document.inaudible_snap_results import (
    InaudibleCutDetails,
    InaudibleCutPassthroughDetails,
    InaudibleCutPreview,
    SilenceIslandWire,
    WaveformSnapWindow,
)

pytestmark = pytest.mark.unscoped_ok

snap_project = wire.snap_project
ws = wire.ws


def _keys(typed: type) -> list[str]:
    return list(get_type_hints(typed))


def _required(typed: type) -> bool:
    return not typed.__optional_keys__ and set(typed.__required_keys__) == set(_keys(typed))


def _previews(ws_: Any) -> dict[str, InaudibleCutPreview]:
    service = AnalysisService(ws_)
    return {name: service.preview_inaudible_cut(**kw) for name, kw in wire.PREVIEW_CASES.items()}


def test_every_wire_typed_dict_has_only_required_keys() -> None:
    for typed in (
        InaudibleCutPassthroughDetails,
        InaudibleCutDetails,
        InaudibleCutPreview,
        SilenceIslandWire,
        WaveformSnapWindow,
    ):
        assert _required(typed)


def test_declared_key_order() -> None:
    assert _keys(InaudibleCutPassthroughDetails) == ["strategy"]
    assert _keys(InaudibleCutDetails) == [
        "strategy",
        "search_window_ms",
        "max_shift_ms",
        "trailing_energy_extended",
        "absorb_trailing_silence",
    ]
    assert _keys(InaudibleCutPreview) == [
        "track_id",
        "timeline_mode",
        "start",
        "end",
        "mode",
        "shifted_start_ms",
        "shifted_end_ms",
        "confidence",
        "details",
    ]
    assert _keys(SilenceIslandWire) == ["start", "end", "duration", "midpoint"]
    assert _keys(WaveformSnapWindow) == [
        "track_id",
        "start",
        "end",
        "timeline_mode",
        "preview",
        "islands",
        "ticks",
    ]


def test_declared_field_types() -> None:
    preview = get_type_hints(InaudibleCutPreview)
    assert preview["mode"] == CutMode
    assert get_origin(CutMode) is Literal
    assert set(get_args(preview["details"])) == {
        InaudibleCutDetails,
        InaudibleCutPassthroughDetails,
    }
    window = get_type_hints(WaveformSnapWindow)
    assert set(get_args(window["preview"])) == {InaudibleCutPreview, type(None)}
    assert window["islands"] == list[SilenceIslandWire]
    assert window["ticks"] == list[float]
    assert set(get_type_hints(SilenceIslandWire).values()) == {float}


def test_preview_matches_the_engine_in_both_details_shapes(ws) -> None:
    outs = _previews(ws)
    shapes = {tuple(out["details"]) for out in outs.values()}
    assert shapes == {
        tuple(_keys(InaudibleCutDetails)),
        tuple(_keys(InaudibleCutPassthroughDetails)),
    }
    for out in outs.values():
        assert list(out) == _keys(InaudibleCutPreview)
        assert out["mode"] in get_args(CutMode)
        details_type = (
            InaudibleCutDetails if len(out["details"]) > 1 else InaudibleCutPassthroughDetails
        )
        hints = get_type_hints(details_type)
        for key, value in out["details"].items():
            assert isinstance(value, hints[key])
    assert {out["mode"] for out in outs.values()} == set(get_args(CutMode))


def test_snap_window_and_islands_match_the_engine(ws) -> None:
    service = AnalysisService(ws)
    seen_islands: list[dict[str, float]] = []
    for kwargs in wire.SNAP_CASES.values():
        out = service.waveform_snap_window(**kwargs)
        assert list(out) == _keys(WaveformSnapWindow)
        assert out["preview"] is None or list(out["preview"]) == _keys(InaudibleCutPreview)
        seen_islands.extend(out["islands"])
    assert seen_islands
    for island in seen_islands:
        assert list(island) == _keys(SilenceIslandWire)
    sample = SilenceIsland(start=1.0, end=2.0).to_dict()
    assert list(sample) == _keys(SilenceIslandWire)


def test_results_round_trip_through_json_unchanged(ws) -> None:
    service = AnalysisService(ws)
    for out in _previews(ws).values():
        assert json.loads(json.dumps(out)) == out
    for kwargs in wire.SNAP_CASES.values():
        out = service.waveform_snap_window(**kwargs)
        assert json.loads(json.dumps(out)) == out
        assert json.dumps(out) == json.dumps(dict(out))


def test_int_edges_survive_in_the_preview_and_become_float_ticks(ws) -> None:
    preview, kwargs = wire.TICK_INPUTS["int_edges_become_floats"]
    with patch.object(AnalysisService, "preview_inaudible_cut", return_value=preview):
        out = AnalysisService(ws).waveform_snap_window(**kwargs)
    assert out["preview"] is preview
    assert out["preview"] is not None
    assert type(out["preview"]["start"]) is int
    assert type(out["preview"]["end"]) is int
    assert all(type(tick) is float for tick in out["ticks"])
    assert json.dumps(out["preview"]) == json.dumps(preview)
