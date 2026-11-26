"""The applied-edit, revert, render status, impact and suggest TypedDicts match the pinned wire output."""

import ast
from pathlib import Path
from typing import Any, get_args

import pytest
from pydantic import TypeAdapter

from podcast_mcp.edits.edit_log import RestoreConflict, RestoreResult, RestoreState
from podcast_mcp.models.episode import (
    AppliedEditRecord,
    EditDecision,
    EditDecisionType,
    RangeInterval,
    RenderInvalidation,
)
from podcast_mcp.services.document import edit_wire_results as results
from podcast_mcp.services.document.edit_wire_results import (
    AppliedEditsWithRestore,
    AppliedEditWire,
    EditImpactReport,
    ImpactSegment,
    PremixStatus,
    RangeIntervalWire,
    RenderInvalidationWire,
    RenderStatusReport,
    RestoreConflictWire,
    RestoreStateWire,
    RevertResult,
    SuggestedEdit,
    TrackRenderStatus,
)
from test_edit_applied_wire import _EXPECTED as _APPLIED
from test_edit_impact_wire import _EXPECTED as _IMPACT
from test_edit_render_premix_wire import _EXPECTED as _PREMIX
from test_edit_render_status_wire import _EXPECTED as _STATUS
from test_edit_revert_wire import _EXPECTED as _REVERT
from test_edit_suggest_wire import _EXPECTED as _SUGGEST

pytestmark = pytest.mark.unscoped_ok


class _Pins:
    def __init__(self, tp: Any) -> None:
        self._adapter = TypeAdapter(tp)

    def validate_python(self, pin: Any) -> None:
        assert self._adapter.validate_python(pin) == pin


def _keys(td: type) -> set[str]:
    return set(td.__annotations__)


def test_module_has_no_future_import():
    tree = ast.parse(Path(results.__file__).read_text(encoding="utf-8"))
    imports = [n for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)]
    assert "__future__" not in {n.module for n in imports}


def test_typed_dicts_come_from_typing_extensions():
    source = Path(results.__file__).read_text(encoding="utf-8")
    assert "from typing_extensions import TypedDict" in source


def test_only_the_premix_size_and_mtime_are_optional():
    assert set(PremixStatus.__optional_keys__) == {"mtime_sec", "size_bytes"}
    for td in (
        TrackRenderStatus,
        AppliedEditWire,
        SuggestedEdit,
        ImpactSegment,
        RenderStatusReport,
    ):
        assert set(td.__optional_keys__) == set()


def test_mirrors_follow_the_pydantic_models():
    assert _keys(RestoreConflictWire) == set(RestoreConflict.model_fields)
    assert _keys(RestoreStateWire) == set(RestoreState.model_fields)
    assert _keys(RenderInvalidationWire) == set(RenderInvalidation.model_fields)
    assert _keys(RangeIntervalWire) == set(RangeInterval.model_fields)
    assert _keys(AppliedEditWire) == (set(AppliedEditRecord.model_fields) - {"inverse"}) | {
        "restore"
    }
    assert _keys(SuggestedEdit) == set(EditDecision.model_fields) - {"bound_pad"}


def test_literals_follow_the_pydantic_models():
    assert get_args(RestoreStateWire.__annotations__["state"]) == get_args(
        RestoreState.model_fields["state"].annotation
    )
    assert {t.__annotations__["status"].__args__[0] for t in get_args(RevertResult)} == set(
        get_args(RestoreResult.model_fields["status"].annotation)
    )
    assert set(get_args(SuggestedEdit.__annotations__["type"])) == {
        EditDecisionType.REMOVE.value,
        EditDecisionType.MUTE.value,
    }


def test_revert_pins_validate():
    pins = _Pins(RevertResult)
    seen = 0
    for results_for_case in _REVERT.values():
        for pin in results_for_case:
            pins.validate_python(pin)
            seen += 1
    assert seen


def test_applied_pins_validate():
    pins = _Pins(AppliedEditsWithRestore)
    for pin in _APPLIED.values():
        pins.validate_python(pin)


def test_render_status_pins_validate():
    pins = _Pins(RenderStatusReport)
    for pin in [*_STATUS.values(), *_PREMIX.values()]:
        pins.validate_python(pin)


def test_impact_pins_validate():
    pins = _Pins(EditImpactReport)
    for pin in _IMPACT.values():
        pins.validate_python(pin)


def test_suggest_pins_validate():
    pins = _Pins(SuggestedEdit)
    for pin in _SUGGEST.values():
        pins.validate_python(pin)
