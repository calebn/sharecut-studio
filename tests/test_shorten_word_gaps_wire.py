"""Pin the wire shape of ``TimelineService.shorten_word_gaps``.

One service call has three result shapes: APPLIED (the full report), UNCHANGED (no gap
qualified) and HELD (another speaker talks in the pause). The service result, the
``edit shorten-gaps`` CLI (``json.dumps(indent=2)``), ``shorten_gaps_tool`` (``to_json``) and
the document-sync handler carry the same dict. ``_as_dict`` lets the same expectations hold if
the service returns a model instead of a bare dict.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from pause_policy_public_helpers import configure, defaults
from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.mcp.tools.history import history_status_tool
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TimelineService
from podcast_mcp.services.document_sync.handlers import edits as edit_handlers
from test_shorten_gaps_tool_pin import _HELD_WORDS, _HOST_GAP, _path

pytestmark = pytest.mark.unscoped_ok

runner = CliRunner()

APPLIED_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "max_gap_sec",
    "use_inaudible_opt",
    "timeline_start",
    "timeline_end",
    "span_count",
    "per_track_source",
]
UNCHANGED_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "unchanged",
]
HELD_KEYS = ["operation", "unchanged", "needs_confirmation", "apply_anyway"]
HELD_INNER_KEYS = ["status", "reason", "message", "speech"]
UNCHANGED = {
    "operation": "shorten_word_gaps",
    "affected_tracks": [],
    "clip_count": 2,
    "timeline_duration_sec": 6.0,
    "unchanged": True,
}
UNCHANGED_TEXT = (
    '{\n  "operation": "shorten_word_gaps",\n  "affected_tracks": [],\n  "clip_count": 2,\n'
    '  "timeline_duration_sec": 6.0,\n  "unchanged": true\n}'
)
APPLY_ANYWAY = (
    "To apply it as is, repeat the call with override_audio_checks=true "
    "(CLI --override-audio-checks)."
)
HELD_MESSAGE = (
    'This also cuts Guest\'s speech at 0:00.5 ("g0"). '
    "Review this cut in Studio, or leave a gap to keep it."
)
CLI_HOLD_TAIL = (
    "Nothing changed. To apply this cut as is, repeat the command with --override-audio-checks."
)
SPAN = pytest.approx(0.65)


def _as_dict(result: Any) -> dict:
    return result.model_dump(mode="json") if hasattr(result, "model_dump") else result


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.delenv("PODCAST_DEBUG", raising=False)
    configure(monkeypatch, defaults())


def _service(path: str, max_gap=0.35, inaudible=False) -> dict:
    ws = ProjectWorkspace.open(Path(path))
    return _as_dict(TimelineService(ws).shorten_word_gaps(max_gap, use_inaudible_opt=inaudible))


def _cli(path: str, *extra: str):
    return runner.invoke(app, ["edit", "shorten-gaps", "--project", path, *extra])


def _handler(path: str, **payload) -> dict:
    params = {
        "max_gap_sec": 0.35,
        "use_inaudible_opt": False,
        "override_audio_checks": False,
        **payload,
    }
    return _as_dict(edit_handlers.shorten_word_gaps(ProjectWorkspace.open(Path(path)), params))


def _applied(tmp_path, name="a") -> str:
    return _path(tmp_path, _HOST_GAP, name)


def _unchanged(tmp_path, name="u") -> str:
    return _path(tmp_path, _HOST_GAP, name)


def _held(tmp_path, name="h") -> str:
    return _path(tmp_path, _HELD_WORDS, name)


def _check_applied(result: dict, *, max_gap=0.35, inaudible=False, cut_speech=False) -> None:
    keys = [*APPLIED_KEYS, "cut_speech"] if cut_speech else APPLIED_KEYS
    assert list(result) == keys
    assert result["operation"] == "shorten_word_gaps"
    assert result["affected_tracks"] == ["host", "guest"]
    assert result["clip_count"] == 4
    assert result["timeline_duration_sec"] == pytest.approx(5.55)
    assert result["max_gap_sec"] == max_gap
    assert result["use_inaudible_opt"] is inaudible
    assert result["timeline_start"] == pytest.approx(0.2)
    assert result["timeline_end"] == SPAN
    assert result["span_count"] == 1
    assert list(result["per_track_source"]) == ["host", "guest"]
    assert result["per_track_source"] == {
        "host": [pytest.approx(0.2), SPAN],
        "guest": [pytest.approx(0.2), SPAN],
    }


def _check_held(result: dict) -> None:
    assert list(result) == HELD_KEYS
    assert result["operation"] == "shorten_word_gaps"
    assert result["unchanged"] is True
    assert result["apply_anyway"] == APPLY_ANYWAY
    held = result["needs_confirmation"]
    assert list(held) == HELD_INNER_KEYS
    assert held["status"] == "needs_confirmation"
    assert held["reason"] == "cuts_other_speech"
    assert held["message"] == HELD_MESSAGE
    assert list(held["speech"]) == ["spans", "tracks"]
    assert held["speech"]["spans"] == [{"start": pytest.approx(0.2), "end": SPAN}]
    assert [list(s) for s in held["speech"]["spans"]] == [["start", "end"]]
    (track,) = held["speech"]["tracks"]
    assert list(track) == ["track_id", "speaker", "words", "sound_spans"]
    assert track["track_id"] == "guest"
    assert track["speaker"] == "Guest"
    assert track["sound_spans"] == []
    assert track["words"] == [
        {"text": "g0", "timeline_start": pytest.approx(0.5), "timeline_end": pytest.approx(0.7)}
    ]
    assert list(track["words"][0]) == ["text", "timeline_start", "timeline_end"]


def _untouched(path: str, before: bytes) -> None:
    assert Path(path).read_bytes() == before
    assert json.loads(history_status_tool(path))["total"] == 0


def _stdout_is_indent_2(stdout: str) -> dict:
    assert stdout.endswith("}\n")
    body = json.loads(stdout)
    assert stdout == json.dumps(body, indent=2) + "\n"
    return body


# ------------------------------------------------------------------ service


def test_applied_service_result_key_order_and_values(tmp_path):
    _check_applied(_service(_applied(tmp_path)))


def test_applied_service_result_with_the_default_optimisation_echoes_none(tmp_path):
    result = _service(_applied(tmp_path), inaudible=None)
    assert list(result) == APPLIED_KEYS
    assert result["use_inaudible_opt"] is None


def test_unchanged_service_result_is_exactly_five_keys_in_order(tmp_path):
    result = _service(_unchanged(tmp_path), 5.0)
    assert list(result) == UNCHANGED_KEYS
    assert result == UNCHANGED
    assert result["clip_count"] == 2
    assert type(result["clip_count"]) is int
    assert type(result["timeline_duration_sec"]) is float
    assert result["unchanged"] is True


def test_held_service_result_key_order_and_values(tmp_path):
    _check_held(_service(_held(tmp_path)))


def test_held_service_result_is_the_same_dict_when_repeated(tmp_path):
    path = _held(tmp_path)
    assert _service(path) == _service(path)


@pytest.mark.parametrize("flag", [None, True, False])
def test_use_inaudible_opt_is_echoed_as_given(tmp_path, flag):
    result = _service(_applied(tmp_path), inaudible=flag)
    assert result["use_inaudible_opt"] is flag
    assert list(result) == APPLIED_KEYS


def test_max_gap_zero_echoes_int_vs_float_as_passed(tmp_path):
    as_int = _service(_applied(tmp_path, "i"), 0)
    as_float = _service(_applied(tmp_path, "f"), 0.0)
    assert list(as_int) == list(as_float) == APPLIED_KEYS
    assert as_int["max_gap_sec"] == as_float["max_gap_sec"] == 0
    assert type(as_int["max_gap_sec"]) is int
    assert type(as_float["max_gap_sec"]) is float
    assert as_int["span_count"] == as_float["span_count"] == 3
    assert as_int["clip_count"] == as_float["clip_count"] == 8


def test_max_gap_half_is_echoed_as_a_float(tmp_path):
    result = _service(_applied(tmp_path), 0.5)
    assert result["max_gap_sec"] == 0.5
    assert type(result["max_gap_sec"]) is float
    assert result["timeline_end"] == pytest.approx(0.5)
    assert result["timeline_duration_sec"] == pytest.approx(5.7)


@pytest.mark.parametrize("max_gap", [1, 1.0])
def test_a_gap_limit_that_nothing_exceeds_is_unchanged_whatever_its_type(tmp_path, max_gap):
    path = _unchanged(tmp_path)
    before = Path(path).read_bytes()
    result = _service(path, max_gap)
    assert list(result) == UNCHANGED_KEYS
    assert "max_gap_sec" not in result
    assert result == UNCHANGED
    _untouched(path, before)


def test_applied_with_the_override_adds_cut_speech_as_the_last_key(tmp_path):
    path = _held(tmp_path)
    result = _handler(path, override_audio_checks=True)
    _check_applied(result, cut_speech=True)
    cut = result["cut_speech"]
    assert list(cut) == ["spans", "tracks"]
    assert [t["track_id"] for t in cut["tracks"]] == ["guest"]
    assert list(cut["tracks"][0]) == ["track_id", "speaker", "words", "sound_spans"]


def test_a_plain_applied_result_has_no_cut_speech_key(tmp_path):
    assert "cut_speech" not in _service(_applied(tmp_path))


def test_unchanged_and_held_leave_the_project_file_and_history_untouched(tmp_path):
    for path, max_gap in ((_unchanged(tmp_path), 5.0), (_held(tmp_path), 0.35)):
        before = Path(path).read_bytes()
        _service(path, max_gap)
        _untouched(path, before)


def test_applied_service_call_writes_two_history_steps(tmp_path):
    path = _applied(tmp_path)
    before = Path(path).read_bytes()
    _service(path)
    assert Path(path).read_bytes() != before
    assert json.loads(history_status_tool(path))["total"] == 2


# ------------------------------------------------------------------ CLI


def test_cli_applied_stdout_is_the_indented_report_and_exit_zero(tmp_path):
    result = _cli(_applied(tmp_path), "--no-inaudible-opt")
    assert result.exit_code == 0
    body = _stdout_is_indent_2(result.stdout)
    _check_applied(body)
    assert result.stdout.startswith(
        '{\n  "operation": "shorten_word_gaps",\n  "affected_tracks": [\n    "host",\n'
        '    "guest"\n  ],\n  "clip_count": 4,\n  "timeline_duration_sec": 5.55,\n'
        '  "max_gap_sec": 0.35,\n  "use_inaudible_opt": false,\n  "timeline_start": 0.2,\n'
    )


def test_cli_default_optimisation_echoes_true(tmp_path):
    result = _cli(_applied(tmp_path))
    assert result.exit_code == 0
    body = _stdout_is_indent_2(result.stdout)
    assert list(body) == APPLIED_KEYS
    assert body["use_inaudible_opt"] is True
    assert body["max_gap_sec"] == 0.35


def test_cli_max_gap_is_always_a_float(tmp_path):
    result = _cli(_applied(tmp_path), "--max-gap", "0", "--no-inaudible-opt")
    assert result.exit_code == 0
    assert '"max_gap_sec": 0.0,' in result.stdout


def test_cli_unchanged_stdout_bytes_and_exit_zero(tmp_path):
    path = _unchanged(tmp_path)
    before = Path(path).read_bytes()
    result = _cli(path, "--max-gap", "5")
    assert result.exit_code == 0
    assert result.stdout == UNCHANGED_TEXT + "\n"
    _untouched(path, before)


def test_cli_held_prints_nothing_on_stdout_exits_one_and_changes_nothing(tmp_path):
    path = _held(tmp_path)
    before = Path(path).read_bytes()
    result = _cli(path, "--no-inaudible-opt")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert result.stderr == f"{HELD_MESSAGE}\n{CLI_HOLD_TAIL}\n"
    _untouched(path, before)


def test_cli_held_with_the_override_applies_and_prints_cut_speech_last(tmp_path):
    result = _cli(_held(tmp_path), "--no-inaudible-opt", "--override-audio-checks")
    assert result.exit_code == 0
    _check_applied(_stdout_is_indent_2(result.stdout), cut_speech=True)


# ------------------------------------------------------------------ MCP tool


def _tool(path: str, *args) -> str:
    return mcp_timeline.shorten_gaps_tool(path, *args)


def test_tool_applied_text_is_the_indented_report(tmp_path):
    text = _tool(_applied(tmp_path), 0.35, False)
    assert not text.endswith("\n")
    body = json.loads(text)
    assert text == json.dumps(body, indent=2)
    _check_applied(body)
    assert text.startswith(
        '{\n  "operation": "shorten_word_gaps",\n  "affected_tracks": [\n    "host",\n'
        '    "guest"\n  ],\n  "clip_count": 4,\n  "timeline_duration_sec": 5.55,\n'
        '  "max_gap_sec": 0.35,\n  "use_inaudible_opt": false,\n  "timeline_start": 0.2,\n'
    )


def test_tool_default_optimisation_echoes_null(tmp_path):
    body = json.loads(_tool(_applied(tmp_path)))
    assert list(body) == APPLIED_KEYS
    assert body["use_inaudible_opt"] is None


def test_tool_echoes_the_max_gap_as_a_float_even_when_given_an_int(tmp_path):
    as_int = _tool(_applied(tmp_path, "i"), 0, False)
    as_float = _tool(_applied(tmp_path, "f"), 0.0, False)
    assert '"max_gap_sec": 0.0,' in as_int
    assert '"max_gap_sec": 0.0,' in as_float


def test_tool_unchanged_text_and_project_untouched(tmp_path):
    path = _unchanged(tmp_path)
    before = Path(path).read_bytes()
    assert _tool(path, 5.0) == UNCHANGED_TEXT
    assert _tool(path, 1, False) == UNCHANGED_TEXT
    assert Path(path).read_bytes() == before
    assert json.loads(history_status_tool(path))["total"] == 0


def test_tool_held_text_and_project_untouched(tmp_path):
    path = _held(tmp_path)
    before = Path(path).read_bytes()
    text = _tool(path, 0.35, False)
    body = json.loads(text)
    assert text == json.dumps(body, indent=2)
    _check_held(body)
    _untouched(path, before)


def test_tool_override_applies_the_held_cut_with_cut_speech_last(tmp_path):
    body = json.loads(_tool(_held(tmp_path), 0.35, False, True))
    _check_applied(body, cut_speech=True)


# ------------------------------------------------------------------ document-sync handler


def test_handler_applied_matches_the_service_shape(tmp_path):
    _check_applied(_handler(_applied(tmp_path)))


@pytest.mark.parametrize("flag", [None, True, False])
def test_handler_echoes_use_inaudible_opt(tmp_path, flag):
    result = _handler(_applied(tmp_path), use_inaudible_opt=flag)
    assert result["use_inaudible_opt"] is flag


def test_handler_echoes_the_max_gap_type_it_was_given(tmp_path):
    as_int = _handler(_applied(tmp_path, "i"), max_gap_sec=0)
    as_float = _handler(_applied(tmp_path, "f"), max_gap_sec=0.0)
    assert type(as_int["max_gap_sec"]) is int
    assert type(as_float["max_gap_sec"]) is float


def test_handler_unchanged_returns_the_five_key_dict(tmp_path):
    path = _unchanged(tmp_path)
    before = Path(path).read_bytes()
    result = _handler(path, max_gap_sec=5.0)
    assert list(result) == UNCHANGED_KEYS
    assert result == UNCHANGED
    _untouched(path, before)


def test_handler_held_returns_the_four_key_dict_and_changes_nothing(tmp_path):
    path = _held(tmp_path)
    before = Path(path).read_bytes()
    _check_held(_handler(path))
    _untouched(path, before)
