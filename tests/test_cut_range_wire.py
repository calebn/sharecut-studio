"""Pin the wire shape of ``EditService.cut_range`` and ``EditService.ripple_delete_text``.

Result shapes: a RIPPLE ``cut_range`` (``ripple_delete``) is the cut report plus the
echoed params and, last, the ``join_quality`` advisory; a GAP ``cut_range``
(``punch_delete``) is the short punch report; ``ripple_delete_text`` is the cut report with
the ``query`` echoed inside it. A cut that would also cut another speaker's speech is HELD:
it comes back unchanged with ``needs_confirmation`` and the project and its history are
untouched. The service result, ``edit ripple-delete --json`` (``json.dumps(indent=2)``), the
MCP tools (``to_json``) and the document-sync handlers carry the same dict. ``_as_dict`` lets
the same expectations hold if the service returns a model instead of a bare dict.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from typer.testing import CliRunner

from pause_policy_public_helpers import configure, defaults, project, workspace
from podcast_mcp.cli.main import app
from podcast_mcp.edits.source_removals import ScopeChangedAtApproval
from podcast_mcp.edits.transcript_refine_status import TranscriptRefineRequiredError
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.mcp.tools.history import history_status_tool
from podcast_mcp.models import EditMode, Transcript, TranscriptWord, save_project
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document_sync.handlers import edits as edit_handlers
from podcast_mcp.util.coded_error import CodedValueError
from test_shorten_gaps_tool_pin import _HELD_WORDS, _HOST_GAP

pytestmark = pytest.mark.unscoped_ok

runner = CliRunner()

RIPPLE_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "timeline_start",
    "timeline_end",
    "track_ids",
    "use_inaudible_opt",
    "span_count",
    "per_track_source",
]
RIPPLE_KEYS_JOIN = [*RIPPLE_KEYS, "join_quality"]
RIPPLE_KEYS_SPEECH_JOIN = [*RIPPLE_KEYS, "cut_speech", "join_quality"]
GAP_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "timeline_start",
    "timeline_end",
    "mode",
]
TEXT_KEYS = [
    "operation",
    "affected_tracks",
    "clip_count",
    "timeline_duration_sec",
    "query",
    "use_inaudible_opt",
    "timeline_start",
    "timeline_end",
    "span_count",
    "per_track_source",
]
HELD_KEYS = ["operation", "unchanged", "needs_confirmation", "apply_anyway"]
HELD_TEXT_KEYS = [*HELD_KEYS, "query"]
HELD_INNER_KEYS = ["status", "reason", "message", "speech"]
JOIN_QUALITY_KEYS = [
    "track_id",
    "mode",
    "join_sec",
    "timebase",
    "risk",
    "invisibility",
    "verdict",
    "reasons",
    "detectors",
    "calibrated",
    "natural_p95",
    "side_sec",
    "disclaimer",
    "ranker",
]
APPLY_ANYWAY = (
    "To apply it as is, repeat the call with override_audio_checks=true "
    "(CLI --override-audio-checks)."
)
MSG_RANGE_ALL = (
    'This cuts Guest\'s speech at 0:00.5 ("g0"). '
    "Review this cut in Studio, or choose which tracks to cut."
)
MSG_RANGE_HOST = (
    'This also cuts Guest\'s speech at 0:00.5 ("g0"). '
    "Review this cut in Studio, or leave a gap to keep it."
)
MSG_TEXT = (
    'This also cuts Guest\'s speech at 0:00.5 ("g0 g1"). '
    "Review this cut in Studio, or leave a gap to keep it."
)
CLI_HOLD_TAIL = (
    "Nothing changed. To apply this cut as is, repeat the command with --override-audio-checks."
)
RANGE_END_MSG = (
    "timeline_end must be after timeline_start. Pick a timeline_end later than timeline_start."
)
START, END = 0.2, 0.65


def _as_dict(result: Any) -> dict:
    return result.model_dump() if hasattr(result, "model_dump") else result


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.delenv("PODCAST_DEBUG", raising=False)
    configure(monkeypatch, defaults())


def _build(tmp_path, words, name="p", guest_id="guest", refined=True) -> str:
    root = tmp_path / name
    root.mkdir()
    result = project(root, guest="quiet")
    host_words, guest_words = words
    result.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text=f"h{i}", start=a, end=b) for i, (a, b) in enumerate(host_words)
            ],
        ),
        Transcript(
            track_id=guest_id,
            words=[
                TranscriptWord(text=f"g{i}", start=a, end=b) for i, (a, b) in enumerate(guest_words)
            ],
        ),
    ]
    for track in result.tracks:
        if track.id == "guest":
            track.id = guest_id
    for clip in result.clips:
        if clip.track_id == "guest":
            clip.track_id = guest_id
    return str(workspace(result).path) if refined else str(save_project(result))


def _applied(tmp_path, name="a", **kw) -> str:
    return _build(tmp_path, _HOST_GAP, name, **kw)


def _held(tmp_path, name="h", **kw) -> str:
    return _build(tmp_path, _HELD_WORDS, name, **kw)


def _service(path: str) -> EditService:
    return EditService(ProjectWorkspace.open(Path(path)))


def _cut(path: str, start=START, end=END, *, mode=EditMode.RIPPLE, **kw) -> dict:
    return _as_dict(_service(path).cut_range(start, end, mode=mode, **kw))


def _text(path: str, query="h1", **kw) -> dict:
    return _as_dict(_service(path).ripple_delete_text(query, **kw))


def _untouched(path: str, before: bytes) -> None:
    assert Path(path).read_bytes() == before
    assert json.loads(history_status_tool(path))["total"] == 0


def _stdout_is_indent_2(stdout: str) -> dict:
    assert stdout.endswith("}\n")
    body = json.loads(stdout)
    assert stdout == json.dumps(body, indent=2) + "\n"
    return body


def _text_is_indent_2(text: str) -> dict:
    assert not text.endswith("\n")
    body = json.loads(text)
    assert text == json.dumps(body, indent=2)
    return body


def _check_join_quality(join: dict) -> None:
    assert list(join) == JOIN_QUALITY_KEYS
    assert join["track_id"] == "host"
    assert join["mode"] == "existing_join"
    assert join["timebase"] == "timeline"
    assert join["join_sec"] == pytest.approx(START)
    assert join["verdict"] == "fail"
    assert join["risk"] == pytest.approx(0.5434)
    assert join["invisibility"] == pytest.approx(0.4566)
    assert all(list(d) == ["name", "score", "weight", "detail"] for d in join["detectors"])


def _check_ripple(result: dict, *, track_ids=(), inaudible=False, keys=RIPPLE_KEYS_JOIN) -> None:
    assert list(result) == keys
    assert result["operation"] == "ripple_delete"
    assert result["affected_tracks"] == ["host", "guest"]
    assert result["clip_count"] == 4
    assert result["timeline_duration_sec"] == pytest.approx(5.55)
    assert result["timeline_start"] == pytest.approx(START)
    assert result["timeline_end"] == pytest.approx(END)
    assert result["track_ids"] == list(track_ids)
    assert result["use_inaudible_opt"] is inaudible
    assert result["span_count"] == 1
    assert list(result["per_track_source"]) == ["host", "guest"]
    assert result["per_track_source"] == {
        "host": [pytest.approx(START), pytest.approx(END)],
        "guest": [pytest.approx(START), pytest.approx(END)],
    }
    if "join_quality" in result:
        _check_join_quality(result["join_quality"])


def _check_held(result: dict, message: str, *, keys=HELD_KEYS, operation="ripple_delete") -> None:
    assert list(result) == keys
    assert result["operation"] == operation
    assert result["unchanged"] is True
    assert result["apply_anyway"] == APPLY_ANYWAY
    held = result["needs_confirmation"]
    assert list(held) == HELD_INNER_KEYS
    assert held["status"] == "needs_confirmation"
    assert held["reason"] == "cuts_other_speech"
    assert held["message"] == message
    assert list(held["speech"]) == ["spans", "tracks"]
    (track,) = held["speech"]["tracks"]
    assert list(track) == ["track_id", "speaker", "words", "sound_spans"]
    assert track["track_id"] == "guest"
    assert track["speaker"] == "Guest"
    assert track["sound_spans"] == []
    assert all(list(w) == ["text", "timeline_start", "timeline_end"] for w in track["words"])
    assert [list(s) for s in held["speech"]["spans"]] == [["start", "end"]]


def _check_text(result: dict, *, query="h1", inaudible=False) -> None:
    assert list(result) == TEXT_KEYS
    assert result["operation"] == "ripple_delete_text"
    assert result["affected_tracks"] == ["host", "guest"]
    assert result["clip_count"] == 2
    assert result["timeline_duration_sec"] == pytest.approx(4.5)
    assert result["query"] == query
    assert result["use_inaudible_opt"] is inaudible
    assert result["timeline_start"] == pytest.approx(0.0)
    assert result["timeline_end"] == pytest.approx(1.5)
    assert result["span_count"] == 1
    assert result["per_track_source"] == {
        "host": [pytest.approx(0.0), pytest.approx(1.5)],
        "guest": [pytest.approx(0.0), pytest.approx(1.5)],
    }


# ------------------------------------------------------------------ service: ripple cut_range


def test_ripple_applied_with_tracks_key_order_and_values(tmp_path):
    path = _applied(tmp_path)
    before = Path(path).read_bytes()
    result = _cut(path, track_ids=["host", "guest"], use_inaudible_opt=False)
    _check_ripple(result, track_ids=["host", "guest"])
    assert Path(path).read_bytes() != before
    assert json.loads(history_status_tool(path))["total"] == 2


def test_ripple_applied_without_tracks_echoes_an_empty_list(tmp_path):
    result = _cut(_applied(tmp_path), use_inaudible_opt=False)
    _check_ripple(result)
    assert result["track_ids"] == []
    assert type(result["track_ids"]) is list


def test_ripple_track_ids_none_and_empty_list_echo_the_same(tmp_path):
    none = _cut(_applied(tmp_path, "n"), track_ids=None, use_inaudible_opt=False)
    empty = _cut(_applied(tmp_path, "e"), track_ids=[], use_inaudible_opt=False)
    assert list(none) == list(empty) == RIPPLE_KEYS_JOIN
    assert none["track_ids"] == empty["track_ids"] == []


@pytest.mark.parametrize("flag", [None, True, False])
def test_ripple_echoes_use_inaudible_opt_as_given(tmp_path, flag):
    result = _cut(_applied(tmp_path), use_inaudible_opt=flag)
    assert list(result) == RIPPLE_KEYS_JOIN
    assert result["use_inaudible_opt"] is flag
    assert result["operation"] == "ripple_delete"


def test_ripple_optimised_bounds_replace_the_given_range(tmp_path):
    result = _cut(_applied(tmp_path), use_inaudible_opt=True)
    assert result["timeline_start"] == pytest.approx(0.2088125)
    assert result["timeline_end"] == pytest.approx(0.6708125)
    assert result["timeline_duration_sec"] == pytest.approx(5.538)


def test_ripple_int_range_is_echoed_as_the_int_given(tmp_path):
    result = _cut(_applied(tmp_path), 2, 3, use_inaudible_opt=False)
    assert list(result) == RIPPLE_KEYS_JOIN
    assert result["timeline_start"] == 2
    assert result["timeline_end"] == 3
    assert type(result["timeline_start"]) is int
    assert type(result["timeline_end"]) is int
    assert result["timeline_duration_sec"] == pytest.approx(5.0)
    assert result["per_track_source"] == {"host": [2.0, 3.0], "guest": [2.0, 3.0]}


def test_ripple_join_quality_is_the_last_key_and_a_report_dict(tmp_path):
    result = _cut(_applied(tmp_path), use_inaudible_opt=False)
    assert list(result)[-1] == "join_quality"
    _check_join_quality(result["join_quality"])
    assert result["join_quality"]["ranker"] is None
    assert result["join_quality"]["calibrated"] is True


def test_ripple_join_quality_is_absent_when_the_advisory_raises(tmp_path, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("advisory down")

    monkeypatch.setattr("podcast_mcp.services.document.edit.assess_existing_join", boom)
    path = _applied(tmp_path)
    result = _cut(path, use_inaudible_opt=False)
    _check_ripple(result, keys=RIPPLE_KEYS)
    assert "join_quality" not in result
    assert json.loads(history_status_tool(path))["total"] == 2


def test_ripple_join_quality_is_absent_without_a_dialogue_track(tmp_path, monkeypatch):
    monkeypatch.setattr("podcast_mcp.services.document.edit.dialogue_track_ids", lambda p: [])
    result = _cut(_applied(tmp_path), use_inaudible_opt=False)
    _check_ripple(result, keys=RIPPLE_KEYS)


def test_ripple_applied_has_no_cut_speech_key(tmp_path):
    assert "cut_speech" not in _cut(_applied(tmp_path), use_inaudible_opt=False)


def test_ripple_over_another_speakers_speech_is_held_and_changes_nothing(tmp_path):
    path = _held(tmp_path)
    before = Path(path).read_bytes()
    result = _cut(path, 0.5, 0.7, track_ids=["host"], use_inaudible_opt=False)
    _check_held(result, MSG_RANGE_HOST)
    assert result["needs_confirmation"]["speech"]["spans"] == [{"start": 0.5, "end": 0.7}]
    (track,) = result["needs_confirmation"]["speech"]["tracks"]
    assert track["words"] == [{"text": "g0", "timeline_start": 0.5, "timeline_end": 0.7}]
    _untouched(path, before)


def test_ripple_with_no_tracks_named_holds_on_everyones_speech(tmp_path):
    path = _held(tmp_path)
    before = Path(path).read_bytes()
    _check_held(_cut(path, 0.5, 0.7, use_inaudible_opt=False), MSG_RANGE_ALL)
    _untouched(path, before)


def test_ripple_held_result_is_the_same_dict_when_repeated(tmp_path):
    path = _held(tmp_path)
    kw = {"track_ids": ["host"], "use_inaudible_opt": False}
    assert _cut(path, 0.5, 0.7, **kw) == _cut(path, 0.5, 0.7, **kw)


def test_ripple_held_has_no_join_quality_and_no_param_echo(tmp_path):
    result = _cut(_held(tmp_path), 0.5, 0.7, use_inaudible_opt=False)
    for key in ("join_quality", "track_ids", "use_inaudible_opt", "timeline_start", "mode"):
        assert key not in result


# ------------------------------------------------------------------ service: gap cut_range


def test_gap_applied_with_tracks_key_order_and_values(tmp_path):
    path = _applied(tmp_path)
    result = _cut(path, mode=EditMode.GAP, track_ids=["guest"])
    assert list(result) == GAP_KEYS
    assert result["operation"] == "punch_delete"
    assert result["affected_tracks"] == ["guest"]
    assert result["clip_count"] == 3
    assert result["timeline_duration_sec"] == 6.0
    assert result["timeline_start"] == START
    assert result["timeline_end"] == END
    assert result["mode"] == "gap"
    assert json.loads(history_status_tool(path))["total"] == 2


def test_gap_without_tracks_punches_every_dialogue_track(tmp_path):
    result = _cut(_applied(tmp_path), mode=EditMode.GAP)
    assert list(result) == GAP_KEYS
    assert sorted(result["affected_tracks"]) == ["guest", "host"]
    assert result["clip_count"] == 4
    assert "track_ids" not in result
    assert "join_quality" not in result
    assert "use_inaudible_opt" not in result


def test_gap_ignores_use_inaudible_opt_and_does_not_echo_it(tmp_path):
    result = _cut(_applied(tmp_path), mode=EditMode.GAP, use_inaudible_opt=True)
    assert list(result) == GAP_KEYS
    assert result["timeline_start"] == START
    assert result["timeline_end"] == END


def test_gap_echoes_the_range_as_given_int_stays_int(tmp_path):
    as_int = _cut(_applied(tmp_path, "i"), 2, 3, mode=EditMode.GAP, track_ids=["host"])
    as_float = _cut(_applied(tmp_path, "f"), 2.0, 3.0, mode=EditMode.GAP, track_ids=["host"])
    assert list(as_int) == list(as_float) == GAP_KEYS
    assert as_int["timeline_start"] == as_float["timeline_start"] == 2
    assert type(as_int["timeline_start"]) is int
    assert type(as_int["timeline_end"]) is int
    assert type(as_float["timeline_start"]) is float
    assert type(as_float["timeline_end"]) is float


def test_gap_over_another_speakers_speech_is_applied_not_held(tmp_path):
    path = _held(tmp_path)
    result = _cut(path, 0.5, 0.7, mode=EditMode.GAP, track_ids=["host"])
    assert list(result) == GAP_KEYS
    assert result["affected_tracks"] == ["host"]
    assert "needs_confirmation" not in result
    assert json.loads(history_status_tool(path))["total"] == 2


# ------------------------------------------------------------------ service: errors


@pytest.mark.parametrize("mode", [EditMode.RIPPLE, EditMode.GAP])
@pytest.mark.parametrize("span", [(0.7, 0.2), (0.5, 0.5)])
def test_a_range_that_does_not_end_after_it_starts_raises_and_changes_nothing(tmp_path, mode, span):
    path = _applied(tmp_path)
    before = Path(path).read_bytes()
    with pytest.raises(CodedValueError) as raised:
        _cut(path, *span, mode=mode)
    assert raised.value.code == "range_end_before_start"
    assert str(raised.value) == RANGE_END_MSG
    _untouched(path, before)


@pytest.mark.refine_gate
def test_an_unrefined_transcript_blocks_every_cut_and_changes_nothing(tmp_path):
    path = _applied(tmp_path, refined=False)
    before = Path(path).read_bytes()
    for call in (
        lambda: _cut(path),
        lambda: _cut(path, mode=EditMode.GAP),
        lambda: _text(path),
    ):
        with pytest.raises(TranscriptRefineRequiredError) as raised:
            call()
        assert raised.value.code == "transcript_refine_required"
        assert str(raised.value).startswith("Transcript refine is required before focus/tighten/NL")
    _untouched(path, before)


# ------------------------------------------------------------------ service: ripple_delete_text


def test_text_applied_key_order_and_values_with_query_after_the_duration(tmp_path):
    path = _applied(tmp_path)
    result = _text(path, use_inaudible_opt=False)
    _check_text(result)
    assert list(result).index("query") == 4
    assert json.loads(history_status_tool(path))["total"] == 2


def test_text_multiword_query_is_echoed_verbatim(tmp_path):
    result = _text(_applied(tmp_path), "h1 h2", use_inaudible_opt=False)
    _check_text(result, query="h1 h2")


def test_text_has_no_join_quality_and_no_cut_speech(tmp_path):
    result = _text(_applied(tmp_path), use_inaudible_opt=False)
    assert "join_quality" not in result
    assert "cut_speech" not in result
    assert "track_ids" not in result


def test_text_default_optimisation_that_holds_the_cut_raises_scope_changed(tmp_path):
    path = _applied(tmp_path)
    before = Path(path).read_bytes()
    with pytest.raises(ScopeChangedAtApproval) as raised:
        _text(path)
    assert raised.value.code == "cut_scope_changed"
    assert str(raised.value).startswith("Host's cut at 0:00.0 was not applied because the held")
    _untouched(path, before)


def test_text_over_another_speakers_speech_is_held_with_query_last(tmp_path):
    path = _held(tmp_path)
    before = Path(path).read_bytes()
    result = _text(path, use_inaudible_opt=False)
    _check_held(result, MSG_TEXT, keys=HELD_TEXT_KEYS, operation="ripple_delete_text")
    assert result["query"] == "h1"
    assert result["needs_confirmation"]["speech"]["spans"] == [{"start": 0.0, "end": 1.2}]
    (track,) = result["needs_confirmation"]["speech"]["tracks"]
    assert [w["text"] for w in track["words"]] == ["g0", "g1"]
    _untouched(path, before)


@pytest.mark.parametrize("query", ["zzz", "", "café"])
def test_text_with_no_match_raises_no_transcript_match_and_changes_nothing(tmp_path, query):
    path = _applied(tmp_path)
    before = Path(path).read_bytes()
    with pytest.raises(CodedValueError) as raised:
        _text(path, query)
    assert raised.value.code == "no_transcript_match"
    assert str(raised.value) == f"no transcript match for {query!r}"
    _untouched(path, before)


# ------------------------------------------------------------------ CLI


def _cli(path: str, *extra: str):
    return runner.invoke(app, ["edit", "ripple-delete", "--project", path, *extra])


RANGE_ARGS = ("--start", "0.2", "--end", "0.65", "--no-inaudible-opt")


def test_cli_range_default_stdout_is_the_one_line_summary(tmp_path):
    result = _cli(_applied(tmp_path), *RANGE_ARGS)
    assert result.exit_code == 0
    assert (
        result.stdout
        == "Ripple-deleted: timeline now 5.55s, 2 track(s), join fail (risk 0.5434).\n"
    )
    assert result.stderr == ""


def test_cli_range_json_stdout_is_the_indented_report_in_key_order(tmp_path):
    result = _cli(_applied(tmp_path), *RANGE_ARGS, "--json", "--track", "host")
    assert result.exit_code == 0
    body = _stdout_is_indent_2(result.stdout)
    _check_ripple(body, track_ids=["host"])
    assert result.stdout.startswith(
        '{\n  "operation": "ripple_delete",\n  "affected_tracks": [\n    "host",\n'
        '    "guest"\n  ],\n  "clip_count": 4,\n  "timeline_duration_sec": 5.55,\n'
        '  "timeline_start": 0.2,\n  "timeline_end": 0.65,\n  "track_ids": [\n    "host"\n  ],\n'
        '  "use_inaudible_opt": false,\n  "span_count": 1,\n'
    )


def test_cli_range_default_optimisation_echoes_true(tmp_path):
    result = _cli(_applied(tmp_path), "--start", "0.2", "--end", "0.65", "--json")
    assert result.exit_code == 0
    body = _stdout_is_indent_2(result.stdout)
    assert list(body) == RIPPLE_KEYS_JOIN
    assert body["use_inaudible_opt"] is True
    assert body["track_ids"] == []


def test_cli_range_int_bounds_print_as_floats(tmp_path):
    result = _cli(_applied(tmp_path), "--start", "2", "--end", "3", "--no-inaudible-opt", "--json")
    assert result.exit_code == 0
    assert '"timeline_start": 2.0,\n  "timeline_end": 3.0,\n' in result.stdout


def test_cli_range_held_prints_to_stderr_exits_one_and_changes_nothing(tmp_path):
    path = _held(tmp_path)
    before = Path(path).read_bytes()
    result = _cli(path, "--start", "0.5", "--end", "0.7", "--no-inaudible-opt")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert result.stderr == f"{MSG_RANGE_ALL}\n{CLI_HOLD_TAIL}\n"
    _untouched(path, before)


def test_cli_range_held_with_a_named_track_uses_the_also_message(tmp_path):
    path = _held(tmp_path)
    result = _cli(path, "--start", "0.5", "--end", "0.7", "--no-inaudible-opt", "--track", "host")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert result.stderr == f"{MSG_RANGE_HOST}\n{CLI_HOLD_TAIL}\n"


def test_cli_range_override_applies_and_prints_cut_speech_before_join_quality(tmp_path):
    path = _held(tmp_path)
    result = _cli(path, "--start", "0.5", "--end", "0.7", "--override-audio-checks", "--json")
    assert result.exit_code == 0
    body = _stdout_is_indent_2(result.stdout)
    assert list(body) == RIPPLE_KEYS_SPEECH_JOIN
    assert body["use_inaudible_opt"] is False
    assert list(body["cut_speech"]) == ["spans", "tracks"]
    assert [t["track_id"] for t in body["cut_speech"]["tracks"]] == ["guest"]
    assert body["join_quality"]["join_sec"] == pytest.approx(0.5)
    assert body["join_quality"]["verdict"] == "pass"


def test_cli_text_default_stdout_is_the_summary_without_a_join_verdict(tmp_path):
    result = _cli(_applied(tmp_path), "--query", "h1", "--no-inaudible-opt")
    assert result.exit_code == 0
    assert result.stdout == "Ripple-deleted: timeline now 4.50s, 2 track(s).\n"


def test_cli_text_json_stdout_is_the_indented_report(tmp_path):
    result = _cli(_applied(tmp_path), "--query", "h1", "--no-inaudible-opt", "--json")
    assert result.exit_code == 0
    _check_text(_stdout_is_indent_2(result.stdout))
    assert result.stdout.startswith(
        '{\n  "operation": "ripple_delete_text",\n  "affected_tracks": [\n    "host",\n'
        '    "guest"\n  ],\n  "clip_count": 2,\n  "timeline_duration_sec": 4.5,\n'
        '  "query": "h1",\n  "use_inaudible_opt": false,\n'
    )


def test_cli_query_wins_over_a_range(tmp_path):
    result = _cli(_applied(tmp_path), "--query", "h1", *RANGE_ARGS, "--json")
    assert result.exit_code == 0
    assert list(json.loads(result.stdout)) == TEXT_KEYS


def test_cli_text_held_prints_to_stderr_exits_one_and_changes_nothing(tmp_path):
    path = _held(tmp_path)
    before = Path(path).read_bytes()
    result = _cli(path, "--query", "h1", "--no-inaudible-opt")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert result.stderr == f"{MSG_TEXT}\n{CLI_HOLD_TAIL}\n"
    _untouched(path, before)


def test_cli_text_override_applies_the_held_cut(tmp_path):
    result = _cli(_held(tmp_path), "--query", "h1", "--override-audio-checks", "--json")
    assert result.exit_code == 0
    body = json.loads(result.stdout)
    assert list(body) == [*TEXT_KEYS[:-1], "per_track_source", "cut_speech"]
    assert body["use_inaudible_opt"] is False


def test_cli_no_match_prints_the_coded_error_on_stderr_and_exits_one(tmp_path):
    path = _applied(tmp_path)
    before = Path(path).read_bytes()
    result = _cli(path, "--query", "zzz")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert result.stderr == (
        "Error: no transcript match for 'zzz' (code no_transcript_match) "
        "(set PODCAST_DEBUG=1 for the traceback)\n"
    )
    _untouched(path, before)


def test_cli_bad_range_prints_the_coded_error_on_stderr_and_exits_one(tmp_path):
    path = _applied(tmp_path)
    before = Path(path).read_bytes()
    result = _cli(path, "--start", "0.7", "--end", "0.2")
    assert result.exit_code == 1
    assert result.stdout == ""
    assert result.stderr == (
        f"Error: {RANGE_END_MSG} (code range_end_before_start) "
        "(set PODCAST_DEBUG=1 for the traceback)\n"
    )
    _untouched(path, before)


def test_cli_without_a_range_or_query_is_a_usage_error_with_exit_two(tmp_path):
    path = _applied(tmp_path)
    before = Path(path).read_bytes()
    for extra in ((), ("--start", "0.2")):
        result = _cli(path, *extra)
        assert result.exit_code == 2
        assert result.stdout == ""
        assert "provide --start and --end, or --query" in result.stderr
    _untouched(path, before)


@pytest.mark.refine_gate
def test_cli_unrefined_transcript_prints_the_gate_error_and_changes_nothing(tmp_path):
    path = _applied(tmp_path, refined=False)
    before = Path(path).read_bytes()
    for extra in (RANGE_ARGS, ("--query", "h1")):
        result = _cli(path, *extra)
        assert result.exit_code == 1
        assert result.stdout == ""
        assert result.stderr.startswith("Error: Transcript refine is required before focus/tighten")
        assert "(code transcript_refine_required) " in result.stderr
    _untouched(path, before)


def test_cli_non_ascii_track_id_is_escaped_in_the_json_bytes(tmp_path):
    result = _cli(
        _applied(tmp_path, guest_id="gäst-é"),
        *RANGE_ARGS,
        "--json",
        "--track",
        "gäst-é",
    )
    assert result.exit_code == 0
    body = _stdout_is_indent_2(result.stdout)
    assert body["track_ids"] == ["gäst-é"]
    assert body["affected_tracks"] == ["host", "gäst-é"]
    assert '"g\\u00e4st-\\u00e9"' in result.stdout
    assert "ä" not in result.stdout


# ------------------------------------------------------------------ MCP tools


def test_tool_range_text_is_the_indented_report(tmp_path):
    text = mcp_timeline.ripple_delete_tool(_applied(tmp_path), START, END, False)
    body = _text_is_indent_2(text)
    _check_ripple(body)
    assert text.startswith(
        '{\n  "operation": "ripple_delete",\n  "affected_tracks": [\n    "host",\n'
        '    "guest"\n  ],\n  "clip_count": 4,\n  "timeline_duration_sec": 5.55,\n'
        '  "timeline_start": 0.2,\n  "timeline_end": 0.65,\n  "track_ids": [],\n'
        '  "use_inaudible_opt": false,\n'
    )


def test_tool_range_default_optimisation_echoes_null(tmp_path):
    body = json.loads(mcp_timeline.ripple_delete_tool(_applied(tmp_path), START, END))
    assert list(body) == RIPPLE_KEYS_JOIN
    assert body["use_inaudible_opt"] is None


def test_tool_range_echoes_the_named_tracks(tmp_path):
    text = mcp_timeline.ripple_delete_tool(_applied(tmp_path), START, END, False, ["host", "guest"])
    _check_ripple(json.loads(text), track_ids=["host", "guest"])


def test_tool_range_int_bounds_are_echoed_as_floats(tmp_path):
    """The handler's ``float(...)`` coerces the payload, unlike the bare service call."""
    as_int = mcp_timeline.ripple_delete_tool(_applied(tmp_path, "i"), 2, 3, False)
    as_float = mcp_timeline.ripple_delete_tool(_applied(tmp_path, "f"), 2.0, 3.0, False)
    for text in (as_int, as_float):
        assert '"timeline_start": 2.0,\n  "timeline_end": 3.0,\n' in text


def test_tool_range_held_text_and_project_untouched(tmp_path):
    path = _held(tmp_path)
    before = Path(path).read_bytes()
    text = mcp_timeline.ripple_delete_tool(path, 0.5, 0.7, False)
    _check_held(_text_is_indent_2(text), MSG_RANGE_ALL)
    _untouched(path, before)


def test_tool_range_override_applies_with_cut_speech_before_join_quality(tmp_path):
    path = _held(tmp_path)
    text = mcp_timeline.ripple_delete_tool(path, 0.5, 0.7, None, None, True)
    body = _text_is_indent_2(text)
    assert list(body) == RIPPLE_KEYS_SPEECH_JOIN
    assert body["use_inaudible_opt"] is False
    assert body["timeline_duration_sec"] == pytest.approx(5.8)
    assert json.loads(history_status_tool(path))["total"] == 2


def test_tool_range_bad_range_raises_before_touching_the_project(tmp_path):
    path = _applied(tmp_path)
    before = Path(path).read_bytes()
    for span in ((0.7, 0.2), (0.5, 0.5)):
        with pytest.raises(CodedValueError) as raised:
            mcp_timeline.ripple_delete_tool(path, *span)
        assert raised.value.code == "range_end_before_start"
        assert str(raised.value) == RANGE_END_MSG
    _untouched(path, before)


@pytest.mark.refine_gate
def test_tool_range_unrefined_transcript_raises(tmp_path):
    path = _applied(tmp_path, refined=False)
    before = Path(path).read_bytes()
    with pytest.raises(TranscriptRefineRequiredError) as raised:
        mcp_timeline.ripple_delete_tool(path, START, END, False)
    assert raised.value.code == "transcript_refine_required"
    _untouched(path, before)


def test_tool_range_non_ascii_track_id_is_escaped_in_the_text(tmp_path):
    path = _applied(tmp_path, guest_id="gäst-é")
    text = mcp_timeline.ripple_delete_tool(path, START, END, False, ["gäst-é"])
    body = _text_is_indent_2(text)
    assert body["track_ids"] == ["gäst-é"]
    assert body["affected_tracks"] == ["host", "gäst-é"]
    assert '"track_ids": [\n    "g\\u00e4st-\\u00e9"\n  ],' in text
    assert "ä" not in text


def test_tool_range_held_non_ascii_track_id_is_escaped_in_the_text(tmp_path):
    path = _held(tmp_path, guest_id="gäst-é")
    text = mcp_timeline.ripple_delete_tool(path, 0.5, 0.7, False, ["host"])
    body = _text_is_indent_2(text)
    assert body["needs_confirmation"]["speech"]["tracks"][0]["track_id"] == "gäst-é"
    assert '"track_id": "g\\u00e4st-\\u00e9"' in text


def test_tool_text_applied_text_is_the_indented_report(tmp_path):
    text = mcp_timeline.ripple_delete_text_tool(_applied(tmp_path), "h1", False)
    _check_text(_text_is_indent_2(text))
    assert text.startswith(
        '{\n  "operation": "ripple_delete_text",\n  "affected_tracks": [\n    "host",\n'
        '    "guest"\n  ],\n  "clip_count": 2,\n  "timeline_duration_sec": 4.5,\n'
        '  "query": "h1",\n  "use_inaudible_opt": false,\n'
    )


def test_tool_text_held_text_and_project_untouched(tmp_path):
    path = _held(tmp_path)
    before = Path(path).read_bytes()
    text = mcp_timeline.ripple_delete_text_tool(path, "h1", False)
    body = _text_is_indent_2(text)
    _check_held(body, MSG_TEXT, keys=HELD_TEXT_KEYS, operation="ripple_delete_text")
    _untouched(path, before)


def test_tool_text_override_applies_the_held_cut(tmp_path):
    text = mcp_timeline.ripple_delete_text_tool(_held(tmp_path), "h1", None, True)
    body = _text_is_indent_2(text)
    assert list(body) == [*TEXT_KEYS, "cut_speech"]
    assert body["use_inaudible_opt"] is False


@pytest.mark.refine_gate
def test_tool_text_no_match_and_unrefined_raise(tmp_path):
    path = _applied(tmp_path)
    before = Path(path).read_bytes()
    with pytest.raises(CodedValueError) as raised:
        mcp_timeline.ripple_delete_text_tool(path, "zzz")
    assert raised.value.code == "no_transcript_match"
    _untouched(path, before)
    unrefined = _applied(tmp_path, "u", refined=False)
    with pytest.raises(TranscriptRefineRequiredError):
        mcp_timeline.ripple_delete_text_tool(unrefined, "h1", False)


# ------------------------------------------------------------------ document-sync handlers


def _handler_cut(path: str, **payload) -> dict:
    return _as_dict(edit_handlers.cut_range(ProjectWorkspace.open(Path(path)), payload))


def _handler_text(path: str, **payload) -> dict:
    return _as_dict(edit_handlers.ripple_delete_text(ProjectWorkspace.open(Path(path)), payload))


def test_handler_ripple_applied_matches_the_service_shape(tmp_path):
    result = _handler_cut(
        _applied(tmp_path), start=START, end=END, mode="ripple", use_inaudible_opt=False
    )
    _check_ripple(result)


def test_handler_ripple_without_use_inaudible_opt_echoes_none_and_track_ids_empty(tmp_path):
    result = _handler_cut(_applied(tmp_path), start=START, end=END, mode="ripple")
    assert list(result) == RIPPLE_KEYS_JOIN
    assert result["use_inaudible_opt"] is None
    assert result["track_ids"] == []


def test_handler_coerces_the_range_to_float_and_track_ids_to_strings(tmp_path):
    result = _handler_cut(
        _applied(tmp_path),
        start="2",
        end=3,
        mode="ripple",
        track_ids=["host"],
        use_inaudible_opt=False,
    )
    assert type(result["timeline_start"]) is float
    assert result["track_ids"] == ["host"]
    gap = _handler_cut(_applied(tmp_path, "g"), start=2, end=3, mode="gap", track_ids=None)
    assert list(gap) == GAP_KEYS
    assert type(gap["timeline_start"]) is float


def test_handler_gap_applied_returns_the_punch_report(tmp_path):
    result = _handler_cut(_applied(tmp_path), start=START, end=END, mode="gap")
    assert list(result) == GAP_KEYS
    assert result["operation"] == "punch_delete"
    assert result["mode"] == "gap"
    assert sorted(result["affected_tracks"]) == ["guest", "host"]


def test_handler_ripple_held_returns_the_four_key_dict_and_changes_nothing(tmp_path):
    path = _held(tmp_path)
    before = Path(path).read_bytes()
    result = _handler_cut(path, start=0.5, end=0.7, mode="ripple", use_inaudible_opt=False)
    _check_held(result, MSG_RANGE_ALL)
    _untouched(path, before)


def test_handler_text_applied_matches_the_service_shape(tmp_path):
    _check_text(_handler_text(_applied(tmp_path), query="h1", use_inaudible_opt=False))


def test_handler_text_held_returns_the_five_key_dict_and_changes_nothing(tmp_path):
    path = _held(tmp_path)
    before = Path(path).read_bytes()
    result = _handler_text(path, query="h1", use_inaudible_opt=False)
    _check_held(result, MSG_TEXT, keys=HELD_TEXT_KEYS, operation="ripple_delete_text")
    _untouched(path, before)


def test_handler_text_no_match_raises(tmp_path):
    with pytest.raises(CodedValueError) as raised:
        _handler_text(_applied(tmp_path), query="zzz")
    assert raised.value.code == "no_transcript_match"
