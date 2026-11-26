"""The audition-context and prosody-overlay TypedDicts match the pinned wire output (#1811)."""

import ast
from pathlib import Path
from typing import Any, get_args, get_type_hints

import numpy as np
import pytest
from pydantic import TypeAdapter, ValidationError

from play_compose_wire_cases import CASES
from play_compose_wire_helpers import run_service
from podcast_mcp.edits import audition_context as producer
from podcast_mcp.edits.prosody_profile import OVERLAY_SCHEMA
from podcast_mcp.engines import bleed_echo
from podcast_mcp.engines import prosody as prosody_engine
from podcast_mcp.models.episode import (
    AppliedEditRecord,
    CommentActionItem,
    EditDecision,
    ProcessingEffect,
    TimelineComment,
    Track,
    TrackRole,
    Transcript,
)
from podcast_mcp.services.document import play_compose_results as results
from podcast_mcp.services.document.analysis_report_results import HumAnalyzed, HumSkipped
from podcast_mcp.services.document.edit_wire_results import TrackRenderStatus
from podcast_mcp.services.document.play_compose_results import (
    AuditionActionItemWire,
    AuditionAppliedEditWire,
    AuditionAuxiliaryTrackWire,
    AuditionCleanCheckWire,
    AuditionCommentWire,
    AuditionContextReport,
    AuditionEffectWire,
    AuditionHeldCheckWire,
    AuditionHypothesisWire,
    AuditionListenWire,
    AuditionPendingEditWire,
    AuditionStemWire,
    AuditionTrackWire,
    AuditionVisualEventWire,
    AuditionVisualMeasuredWire,
    AuditionVisualUnavailableWire,
    ProsodyBoundaryKind,
    ProsodyEnergyTrend,
    ProsodyEnergyWire,
    ProsodyF0Wire,
    ProsodyOverlayFreshTrack,
    ProsodyOverlayHintedTrack,
    ProsodyOverlayReport,
    ProsodyVoiceQualityWire,
    ProsodyWindowBoundaryWire,
    ProsodyWindowFresh,
    ProsodyWindowNotCached,
    ProsodyWindowSegmentWire,
    ProsodyWindowUnavailable,
)
from test_play_compose_prosody_wire import _EXPECTED as _PROSODY
from test_play_compose_prosody_wire import _OVERLAY_EXPECTED
from test_play_compose_wire import _EXPECTED as _CORE
from test_play_compose_wire_dsp import _EXPECTED as _DSP
from test_play_compose_wire_edits import _EXPECTED as _EDITS

pytestmark = pytest.mark.unscoped_ok

_CONTEXT = TypeAdapter(AuditionContextReport)
_OVERLAY = TypeAdapter(ProsodyOverlayReport)
_PINS = {
    f"{module}:{name}": pin
    for module, pins in (("core", _CORE), ("dsp", _DSP), ("edits", _EDITS), ("prosody", _PROSODY))
    for name, pin in pins.items()
}


def _typed_dicts() -> list[type]:
    return [
        value
        for value in vars(results).values()
        if isinstance(value, type) and hasattr(value, "__required_keys__")
    ]


def _shape(td: type) -> tuple[set[str], set[str]]:
    return set(td.__required_keys__), set(td.__optional_keys__)


def test_module_has_no_future_import():
    tree = ast.parse(Path(results.__file__).read_text(encoding="utf-8"))
    imports = [n for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)]
    assert "__future__" not in {n.module for n in imports}


def test_typed_dicts_come_from_typing_extensions():
    source = Path(results.__file__).read_text(encoding="utf-8")
    assert "from typing_extensions import TypedDict" in source


_NOT_REQUIRED = {
    AuditionContextReport: {"speaker_roles", "visuals"},
    AuditionCommentWire: {"track_ids", "action_items"},
    AuditionPendingEditWire: {"source_start", "source_end", "boundary_mode", "audio_check"},
    AuditionAppliedEditWire: {"track_ids", "source_start", "source_end", "boundary_mode"},
    AuditionListenWire: {"source", "track_ids", "tier", "pair"},
    AuditionVisualEventWire: {"id", "t_end", "x_end"},
    AuditionVisualMeasuredWire: {"annotate_error"},
}


def test_only_the_documented_keys_are_not_required():
    for td in _typed_dicts():
        assert set(td.__optional_keys__) == _NOT_REQUIRED.get(td, set()), td.__name__


@pytest.mark.parametrize("name", list(_PINS))
def test_context_pins_round_trip(name):
    pin = _PINS[name]
    assert _CONTEXT.dump_python(_CONTEXT.validate_python(pin), mode="json") == pin


@pytest.mark.parametrize("name", list(_OVERLAY_EXPECTED))
def test_overlay_pins_round_trip(name):
    pin = _OVERLAY_EXPECTED[name]
    assert _OVERLAY.dump_python(_OVERLAY.validate_python(pin), mode="json") == pin


# --- the shape walk: each pinned node must match one declared variant of its path -------------

_VARIANTS: dict[str, tuple[type, ...]] = {
    "": (AuditionContextReport,),
    "tracks[]": (AuditionTrackWire,),
    "tracks[].prosody": (ProsodyWindowFresh, ProsodyWindowNotCached, ProsodyWindowUnavailable),
    "tracks[].prosody.segments[]": (ProsodyWindowSegmentWire,),
    "auxiliary_tracks[]": (AuditionAuxiliaryTrackWire,),
    "comments[]": (AuditionCommentWire,),
    "edits.pending[]": (AuditionPendingEditWire,),
    "edits.pending[].audio_check": (AuditionHeldCheckWire, AuditionCleanCheckWire),
    "edits.applied[]": (AuditionAppliedEditWire,),
    "suggested_listen[]": (AuditionListenWire,),
    "hypotheses[]": (AuditionHypothesisWire,),
    "visuals[]": (AuditionVisualMeasuredWire, AuditionVisualUnavailableWire),
    "visuals[].events[]": (AuditionVisualEventWire,),
    "visuals[].hum": (HumAnalyzed, HumSkipped),
    "render_status.tracks.*": (AuditionStemWire,),
}
# Variants and keys no pin reaches; the synthetic rows below cover them.
_UNPINNED = {
    ("tracks[].prosody", "ProsodyWindowUnavailable"),
    ("visuals[]", "AuditionVisualMeasuredWire.annotate_error"),
    ("visuals[].hum", "HumSkipped"),
}
_DYNAMIC_MAPS = {"render_status.tracks", "speaker_roles"}


def _fits(td: type, node: dict[str, Any]) -> bool:
    required, optional = _shape(td)
    return required <= set(node) <= required | optional


def _walk(node: Any, path: str, seen: set[tuple[str, str]]) -> None:
    if isinstance(node, list):
        for item in node:
            _walk(item, path + "[]", seen)
        return
    if not isinstance(node, dict):
        return
    if path in _DYNAMIC_MAPS:
        for item in node.values():
            _walk(item, path + ".*", seen)
        return
    if path in _VARIANTS:
        fits = [td for td in _VARIANTS[path] if _fits(td, node)]
        assert fits, f"{path}: {sorted(node)} fits no variant"
        for td in fits:
            seen.add((path, td.__name__))
            seen.update(
                (path, f"{td.__name__}.{key}") for key in node if key in td.__optional_keys__
            )
    for key, item in node.items():
        _walk(item, f"{path}.{key}" if path else key, seen)


def test_every_pinned_node_fits_a_declared_variant_and_every_variant_is_pinned():
    seen: set[tuple[str, str]] = set()
    for pin in _PINS.values():
        _walk(pin, "", seen)
    wanted = {(path, td.__name__) for path, tds in _VARIANTS.items() for td in tds}
    wanted |= {
        (path, f"{td.__name__}.{key}")
        for path, tds in _VARIANTS.items()
        for td in tds
        for key in td.__optional_keys__
    }
    assert wanted - seen == _UNPINNED


_UNPINNED_ROWS: list[tuple[Any, dict[str, Any]]] = [
    (ProsodyWindowUnavailable, {"status": "unavailable", "error": "OSError: disk error"}),
    (HumSkipped, {"hum_detected": False, "reason": "clip too short to analyze"}),
]


@pytest.mark.parametrize(("td", "row"), _UNPINNED_ROWS)
def test_unpinned_variants_round_trip(td, row):
    adapter = TypeAdapter(td)
    assert adapter.dump_python(adapter.validate_python(row), mode="json") == row


def test_a_visual_row_may_carry_an_annotate_error():
    pin = next(row for pin in _PINS.values() for row in pin.get("visuals", []) if "astats" in row)
    adapter = TypeAdapter(AuditionVisualMeasuredWire)
    row = {**pin, "annotate_error": "OSError"}
    assert adapter.dump_python(adapter.validate_python(row), mode="json") == row


# --- the types actually reject drift -----------------------------------------------------------


def test_a_missing_hint_on_a_stale_window_is_rejected():
    adapter = TypeAdapter(ProsodyWindowNotCached)
    with pytest.raises(ValidationError):
        adapter.validate_python({"status": "stale"})


def test_a_fresh_overlay_track_has_no_hint_and_the_others_need_one():
    base = {
        "track_id": "t",
        "segments": [],
        "boundaries": [],
        "prominent_words": [],
        "energy_db": None,
    }
    TypeAdapter(ProsodyOverlayFreshTrack).validate_python({**base, "status": "fresh"})
    with pytest.raises(ValidationError):
        TypeAdapter(ProsodyOverlayHintedTrack).validate_python({**base, "status": "missing"})


def test_an_extra_or_missing_key_fails_the_round_trip():
    pin = _PINS["core:pair-summary"]
    extra = {**pin, "surprise": 1}
    assert _CONTEXT.dump_python(_CONTEXT.validate_python(extra), mode="json") != extra
    with pytest.raises(ValidationError):
        _CONTEXT.validate_python({k: v for k, v in pin.items() if k != "summary"})


# --- literals and keys follow the producers ----------------------------------------------------


def _args(td: type, key: str) -> set[Any]:
    return set(get_args(get_type_hints(td)[key]))


def test_hypothesis_literals_follow_the_catalog():
    catalog = producer.HYPOTHESIS_CATALOG
    assert set(get_args(results.HypothesisCode)) == set(catalog)
    assert set(get_args(results.HypothesisSeverity)) == {s["severity"] for s in catalog.values()}
    assert set(get_args(results.HypothesisConfidence)) == {
        s["confidence"] for s in catalog.values()
    }
    assert set(get_args(results.HypothesisAutonomy)) == {s["autonomy"] for s in catalog.values()}


def test_a_hypothesis_row_has_the_keys_the_producer_builds():
    window = producer._clock_window(0.0, 1.0)
    row = producer._hypothesis("echo_risk", tracks=["a"], window=window, evidence={})
    assert set(row) == set(AuditionHypothesisWire.__annotations__)
    assert set(row["next"]) == set(results.HypothesisNextWire.__annotations__)
    assert set(row["next"]["fix"]) == set(results.HypothesisFixWire.__annotations__)
    assert set(window) == set(results.TimelineWindowWire.__annotations__)


def test_the_scalar_literals_follow_the_producer():
    assert set(get_args(results.AuditionDetail)) == set(get_args(producer.DetailLevel))
    every_limit = producer._limits(
        detail="visual", needs_rerender=True, echo_skipped=True, whisper_word_times=True
    )
    assert set(get_args(results.AuditionLimit)) == set(every_limit)
    assert get_args(get_type_hints(AuditionContextReport)["schema"]) == (producer.SCHEMA_ID,)
    assert get_args(get_type_hints(results.ProsodyOverlayReport)["schema"]) == (OVERLAY_SCHEMA,)
    assert _args(AuditionAuxiliaryTrackWire, "role") == {TrackRole.MUSIC.value, TrackRole.SFX.value}


def test_the_pydantic_models_mirrored_by_the_report_rows_agree():
    def same(td: type, model: type, key: str, field: str | None = None) -> None:
        assert get_type_hints(td)[key] == model.model_fields[field or key].annotation, key

    pending = set(AuditionPendingEditWire.__annotations__)
    assert pending - {
        "timeline_start",
        "timeline_end",
        "source_start",
        "source_end",
        "audio_check",
    } <= set(EditDecision.model_fields)
    for key in ("reason", "review_required", "cut_confidence", "boundary_mode"):
        same(AuditionPendingEditWire, EditDecision, key)
    applied = set(AuditionAppliedEditWire.__annotations__)
    assert applied <= set(AppliedEditRecord.model_fields)
    for key in ("operation", "reason", "cut_confidence", "track_ids", "boundary_mode"):
        same(AuditionAppliedEditWire, AppliedEditRecord, key)
    assert set(AuditionCommentWire.__annotations__) - {"open_action_count"} <= set(
        TimelineComment.model_fields
    )
    assert set(AuditionActionItemWire.__annotations__) == {"id", "text", "done"}
    assert set(AuditionActionItemWire.__annotations__) <= set(CommentActionItem.model_fields)
    assert set(AuditionEffectWire.__annotations__) <= set(ProcessingEffect.model_fields)
    assert set(AuditionStemWire.__annotations__) <= set(TrackRenderStatus.__annotations__)
    same(AuditionTrackWire, Transcript, "word_aligner")
    assert get_type_hints(AuditionTrackWire)["muted"] == Track.model_fields["muted"].annotation


def test_the_prosody_blobs_have_the_keys_the_engine_builds():
    seg_t, seg_db = np.array([0.0, 1.0, 2.0]), np.array([60.0, 61.0, 62.0])
    energy = prosody_engine._energy_stats(seg_t, seg_db)
    assert set(energy) == set(ProsodyEnergyWire.__annotations__)
    assert energy["trend"] in get_args(ProsodyEnergyTrend)
    f0 = prosody_engine._f0_stats(None, np.array([0.0]), np.array([0.0]), 0.0, 1.0)
    assert set(f0) == set(ProsodyF0Wire.__annotations__)
    quality = prosody_engine._voice_quality(jitter=None, shimmer=None, hnr=None)
    assert set(quality) == set(ProsodyVoiceQualityWire.__annotations__)
    (end,) = prosody_engine._boundaries([], None, seg_start=0.0, seg_end=1.0, min_strength=0.0)
    assert set(end) | {"timeline_time"} == set(ProsodyWindowBoundaryWire.__annotations__)
    assert end["kind"] in get_args(ProsodyBoundaryKind)


def test_the_in_process_report_validates_before_it_is_serialized(tmp_path, monkeypatch):
    bleed_echo._cached_profiles.cache_clear()
    case = CASES["aux-full"]
    ws = case.build(tmp_path)
    report = run_service(ws, case.start, case.end, **case.kwargs)
    assert report["auxiliary_tracks"]
    _CONTEXT.validate_python(report)
