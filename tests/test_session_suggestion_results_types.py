"""The staged-session TypedDicts match the pydantic models and the pinned wire output."""

import ast
from pathlib import Path
from typing import Any, get_args

import pytest
from pydantic import TypeAdapter

from podcast_mcp.edits.cut_speech import CutSpeechConfirmation
from podcast_mcp.models.episode import (
    CutSpeech,
    CutSpeechTrack,
    CutSpeechWord,
    InsertAnchor,
    SessionSuggestion,
    StagedComment,
    StagedRoomTone,
    StagedTake,
)
from podcast_mcp.services.document import session_suggestion_results as results
from podcast_mcp.services.document.session_suggestion_results import (
    AcceptHeldWire,
    AcceptInsertedWire,
    AcceptReplacedWire,
    CutSpeechConfirmationWire,
    CutSpeechTrackWire,
    CutSpeechWire,
    CutSpeechWordWire,
    InsertAnchorWire,
    SelectTakeWire,
    SessionSuggestionWire,
    SessionTakesWire,
    StagedCommentWire,
    StagedRoomToneWire,
    StagedTakeWire,
)
from test_session_suggestion_accept_wire import EXPECTED as _ACCEPT
from test_session_suggestion_takes_wire import EXPECTED as _TAKES
from test_session_suggestion_wire import EXPECTED as _WIRE

pytestmark = pytest.mark.unscoped_ok


def _keys(td: type) -> set[str]:
    return set(td.__annotations__)


def test_module_has_no_future_import():
    tree = ast.parse(Path(results.__file__).read_text(encoding="utf-8"))
    imports = [n for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)]
    assert "__future__" not in {n.module for n in imports}


def test_typed_dicts_come_from_typing_extensions():
    source = Path(results.__file__).read_text(encoding="utf-8")
    assert "from typing_extensions import TypedDict" in source


def test_no_key_is_optional():
    for td in _ROOTS.values():
        assert set(td.__optional_keys__) == set()


def test_mirrors_follow_the_pydantic_models():
    assert _keys(SessionSuggestionWire) == set(SessionSuggestion.model_fields)
    assert _keys(InsertAnchorWire) == set(InsertAnchor.model_fields)
    assert _keys(StagedTakeWire) == set(StagedTake.model_fields)
    assert _keys(StagedCommentWire) == set(StagedComment.model_fields)
    assert _keys(StagedRoomToneWire) == set(StagedRoomTone.model_fields)
    assert _keys(CutSpeechConfirmationWire) == set(CutSpeechConfirmation.model_fields)
    assert _keys(CutSpeechWire) == set(CutSpeech.model_fields)
    assert _keys(CutSpeechTrackWire) == set(CutSpeechTrack.model_fields)
    assert _keys(CutSpeechWordWire) == set(CutSpeechWord.model_fields)


def test_literals_follow_the_pydantic_models():
    fields = SessionSuggestion.model_fields
    assert get_args(results.SuggestionKind) == get_args(fields["kind"].annotation)
    assert get_args(results.SuggestionStatus) == get_args(fields["status"].annotation)
    assert get_args(InsertAnchorWire.__annotations__["kind"]) == get_args(
        InsertAnchor.model_fields["kind"].annotation
    )
    side_union = InsertAnchor.model_fields["side"].annotation
    model_sides = {x for x in get_args(side_union) if x is not type(None)}
    wire_union = InsertAnchorWire.__annotations__["side"]
    wire_sides = {x for x in get_args(wire_union) if x is not type(None)}
    assert set(get_args(next(iter(wire_sides)))) == set(get_args(next(iter(model_sides))))


_ROOTS: dict[frozenset[str], Any] = {
    frozenset(_keys(td)): td
    for td in (
        AcceptInsertedWire,
        AcceptReplacedWire,
        AcceptHeldWire,
        SessionTakesWire,
        SelectTakeWire,
        SessionSuggestionWire,
    )
}


def _roots(expected: dict[str, Any]) -> list[dict[str, Any]]:
    roots: list[dict[str, Any]] = []
    for case in expected.values():
        for outcome in case["outcomes"]:
            if "ok" not in outcome:
                continue
            value = outcome["ok"]
            roots.extend(value if isinstance(value, list) else [value])
    return roots


@pytest.mark.parametrize("expected", [_ACCEPT, _TAKES, _WIRE], ids=["accept", "takes", "wire"])
def test_pins_round_trip(expected: dict[str, Any]):
    seen = 0
    for pin in _roots(expected):
        if not isinstance(pin, dict):
            continue
        td = _ROOTS.get(frozenset(pin))
        assert td is not None, sorted(pin)
        assert TypeAdapter(td).validate_python(pin) == pin
        seen += 1
    assert seen
