"""Choosing among a staged replace's takes, and what Accept leaves of the others (#2296 C2)."""

from __future__ import annotations

import json
import math
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app as cli_app
from podcast_mcp.edits.cut_speech import APPLY_ANYWAY
from podcast_mcp.edits.insert_anchor import resolve_range
from podcast_mcp.edits.session_takes import select_session_take, session_takes
from podcast_mcp.mcp.tools.review import (
    accept_session_suggestion_tool,
    list_session_takes_tool,
    select_session_take_tool,
)
from podcast_mcp.models import Transcript, TranscriptWord
from podcast_mcp.project.history.summary import format_history_group_title
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService, PlayService
from podcast_mcp.util.coded_error import CodedValueError
from test_record_replace_accept import _everything, _stage_replace, _words
from test_record_session_preview import (
    _hear,
    _insert,
    _pcm,
    _replace,
    _seconds,
    _svc,
)

# The staged-session project fixture (`ws`) is the one the preview tests use.
pytest_plugins = ["test_record_session_preview"]

CLI = CliRunner()
THREE_TAKES = {
    0: [("host", 0.0, 1.0)],
    1: [("host", 0.0, 2.5)],
    2: [("host", 0.0, 3.5)],
}


def _row(ws):
    ws.reload()
    return ws.project.editorial.session_suggestions[0]


def _said(ws, take_index: int, *texts: str) -> None:
    """Give a staged take's recording a transcript, as if someone had transcribed it."""
    source = next(t.source_id for t in _row(ws).takes if t.take_index == take_index)

    def add(project) -> None:
        project.transcripts.append(
            Transcript(
                track_id="host",
                source_id=source,
                words=[
                    TranscriptWord(text=text, start=0.1 * i, end=0.1 * i + 0.08)
                    for i, text in enumerate(texts)
                ],
            )
        )

    ws.mutate("words", "worded", add)


# --- the list ---


def test_the_list_gives_each_take_its_length_words_and_flags(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    _said(ws, 1, "so", "this", "is", "the", "second", "try")
    listed = _svc(ws).takes(sid)
    assert (listed["kind"], listed["status"], listed["selectable"]) == ("replace", "pending", True)
    assert (listed["selected_take"], listed["default_take"]) == (None, 2)
    zero, one, two = listed["takes"]
    assert [t["take_index"] for t in listed["takes"]] == [0, 1, 2]
    assert [t["duration_s"] for t in listed["takes"]] == [1.0, 2.5, 3.5]
    assert one["tracks"] == [
        {"track_id": "host", "track_label": "Host", "duration_s": 2.5, "segments": 1}
    ]
    assert (one["word_count"], one["speech_text"]) == (6, "so this is the second try")
    # Nobody has transcribed the others: no words is not the same as zero words.
    assert (zero["word_count"], zero["speech_text"]) == (None, None)
    assert [t["chosen"] for t in listed["takes"]] == [False, False, False]
    assert [t["default"] for t in listed["takes"]] == [False, False, True]
    assert all(t["acceptable"] and t["refusal"] is None for t in listed["takes"])
    assert two["duration_s"] == 3.5


def test_a_long_take_shows_a_clipped_snippet_and_a_suppressed_word_is_not_counted(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    _said(ws, 0, *[f"w{i}" for i in range(30)])
    ws.mutate(
        "suppress",
        "suppressed",
        lambda p: setattr(p.transcripts[-1].words[0], "suppressed", True),
    )
    take = _svc(ws).takes(sid)["takes"][0]
    assert take["word_count"] == 29
    assert take["speech_text"].startswith("w1 w2")
    assert take["speech_text"].endswith("…")
    assert len(take["speech_text"]) <= 121


def test_a_take_with_several_tracks_reports_each_tracks_length(ws) -> None:
    sid = _replace(
        ws,
        3.0,
        5.0,
        {0: [("host", 0.0, 2.0), ("guest", 0.5, 2.0)]},
        track_ids=["host", "guest"],
    )
    [take] = _svc(ws).takes(sid)["takes"]
    assert take["duration_s"] == 2.5
    assert {t["track_id"]: t["duration_s"] for t in take["tracks"]} == {"host": 2.0, "guest": 2.5}


def test_a_take_accept_would_refuse_carries_the_refusal_and_is_still_listed(ws) -> None:
    sid = _replace(
        ws,
        3.0,
        5.0,
        {0: [("host", 0.0, 2.0)], 1: [("host", 0.0, 2.0), ("guest", 0.0, 2.0)]},
        track_ids=["host", "guest"],
    )
    zero, one = _svc(ws).takes(sid)["takes"]
    assert (zero["acceptable"], one["acceptable"]) == (False, True)
    with pytest.raises(CodedValueError) as accepted:
        _svc(ws).accept(sid, take_index=0, override_audio_checks=True)
    assert zero["refusal"] == {"code": "track_not_recorded", "message": str(accepted.value)}


def test_an_insert_has_nothing_to_pick(ws) -> None:
    sid = _insert(ws, 4.0, [1.0, 1.5])
    listed = _svc(ws).takes(sid)
    assert (listed["kind"], listed["selectable"], listed["default_take"]) == ("insert", False, None)
    assert [t["chosen"] or t["default"] for t in listed["takes"]] == [False]


def test_a_single_take_is_not_selectable_but_is_the_default(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    listed = _svc(ws).takes(sid)
    assert (listed["selectable"], listed["default_take"]) == (False, 0)


def test_the_list_reads_only_and_an_unknown_id_is_refused(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    before = _everything(ws)
    head = HistoryService(ws).list_entries()
    _svc(ws).takes(sid)
    assert _everything(ws) == before
    assert HistoryService(ws).list_entries() == head
    with pytest.raises(KeyError) as unknown:
        _svc(ws).takes("ss-nope")
    assert unknown.value.code == "session_suggestion_not_found"


# --- SelectTake ---


def test_picking_a_take_sets_it_chosen_and_default_and_is_one_undo_step(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    before = _everything(ws)
    result = _svc(ws).select_take(sid, 1)
    assert result["selected_take"] == 1
    assert result["suggestion"]["selected_take"] == 1
    listed = _svc(ws).takes(sid)
    assert (listed["selected_take"], listed["default_take"]) == (1, 1)
    assert [t["chosen"] for t in listed["takes"]] == [False, True, False]
    assert [t["default"] for t in listed["takes"]] == [False, True, False]
    history = HistoryService(ws)
    history.undo()
    assert _everything(ws) == before
    assert _row(ws).selected_take is None
    history.redo()
    assert _row(ws).selected_take == 1


def test_a_pick_is_titled_in_the_history(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    _svc(ws).select_take(sid, 0)
    assert (
        format_history_group_title(
            kind="mutation",
            operation="select_session_take",
            params={"session_number": 1, "take_index": 0},
        )
        == "Chose take 0 for Session 1"
    )
    ws.reload()
    assert HistoryService(ws).list_entries().groups[-1].title == "Chose take 0 for Session 1"


def test_picking_the_take_already_picked_writes_no_history_step(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    _svc(ws).select_take(sid, 1)
    head = json.dumps(HistoryService(ws).list_entries(), default=str)
    again = _svc(ws).select_take(sid, 1)
    assert again["selected_take"] == 1
    assert json.dumps(HistoryService(ws).list_entries(), default=str) == head
    with pytest.raises(CodedValueError) as unknown:
        _svc(ws).select_take(sid, 9)
    assert unknown.value.code == "take_not_found"


def _refused(ws, sid, take_index) -> CodedValueError:
    with pytest.raises(CodedValueError) as refused:
        _svc(ws).select_take(sid, take_index)
    return refused.value


def test_picking_refuses_in_plain_words_with_the_codes_accept_gives(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    before = _everything(ws)
    unknown = _refused(ws, sid, 7)
    assert unknown.code == "take_not_found"
    assert "has no take 7. Pick one of: 0, 1, 2." in str(unknown)
    with pytest.raises(CodedValueError) as accepted:
        _svc(ws).accept(sid, take_index=7)
    assert str(unknown) == str(accepted.value)
    assert _everything(ws) == before


def test_picking_a_take_on_an_insert_is_refused(ws) -> None:
    sid = _insert(ws, 4.0, [1.0, 1.5])
    refused = _refused(ws, sid, 0)
    assert refused.code == "take_not_applicable"
    assert "an insert" in str(refused)


def test_picking_on_a_decided_session_is_refused(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    _svc(ws).skip(sid)
    refused = _refused(ws, sid, 1)
    assert refused.code == "session_suggestion_not_pending"
    assert "was already skipped" in str(refused)


def test_picking_a_take_that_did_not_record_every_track_is_refused(ws) -> None:
    sid = _replace(
        ws,
        3.0,
        5.0,
        {0: [("host", 0.0, 2.0)], 1: [("host", 0.0, 2.0), ("guest", 0.0, 2.0)]},
        track_ids=["host", "guest"],
    )
    refused = _refused(ws, sid, 0)
    assert refused.code == "track_not_recorded"
    assert _row(ws).selected_take is None


def test_picking_when_the_range_is_gone_is_a_stale_anchor(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    ws.mutate(
        "gone",
        "gone",
        lambda p: setattr(p, "clips", [c for c in p.clips if c.track_id != "host"]),
    )
    refused = _refused(ws, sid, 1)
    assert refused.code == "stale_anchor"
    assert _row(ws).selected_take is None


def test_a_pick_without_a_staged_range_is_stale_too(ws) -> None:
    sid = _stage_replace(ws, 3.0, 5.0, THREE_TAKES, capture=False)
    assert _refused(ws, sid, 1).code == "stale_anchor"


def test_the_pure_functions_agree_with_the_service(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    project = ProjectWorkspace.open(ws.path).project
    assert session_takes(project, sid)["default_take"] == 2
    select_session_take(project, sid, 0)
    assert session_takes(project, sid)["default_take"] == 0


# --- preview, switcher and Accept name the same take ---


@pytest.mark.parametrize("take", [0, 1, 2])
def test_accept_equals_the_previews_suggested_for_the_picked_take(ws, monkeypatch, take) -> None:
    monkeypatch.setattr(PlayService, "mix_trim_db", lambda self, **_kw: -1.0)
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    _svc(ws).select_take(sid, take)
    # No take named: the preview, the list and Accept all follow the pick.
    result = _hear(ws, sid, mode="suggested", pad_sec=1.0)
    assert result["take_index"] == take == _svc(ws).takes(sid)["default_take"]
    accepted = _svc(ws).accept(sid)
    assert accepted["take_index"] == take
    ws.reload()
    heard = ws.project.workspace_path() / "accepted.wav"
    PlayService(ws)._render_mix_window(
        ws.project,
        result["suggested"]["start_s"],
        result["suggested"]["end_s"],
        heard,
        trim_db=-1.0,
    )
    assert _pcm(result["suggested"]["wav"]) == _pcm(heard)
    length = THREE_TAKES[take][0][2]
    assert _seconds(result["suggested"]["wav"]) == pytest.approx(2.0 + length, abs=1 / 48_000)


# --- Accept discards the others ---


def test_accept_keeps_only_the_chosen_takes_staged_rows_and_every_recording(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES, comments={0: [("a", 100)], 2: [("b", 200)]})
    root = ws.project.workspace_path()
    sources = {s.id for s in ws.project.sources}
    files = sorted(p.name for p in (root / "raw").iterdir())
    result = _svc(ws).accept(sid, take_index=1)
    assert result["discarded_takes"] == [0, 2]
    assert result["comments_not_placed"] == 2
    ws.reload()
    row = _row(ws)
    assert {t.take_index for t in row.takes} == {1}
    assert (row.status, row.selected_take) == ("accepted", 1)
    assert result["suggestion"]["takes"] == [t.model_dump(mode="json") for t in row.takes]
    # Recordings stay: a source is only a registry row and a file, and history may name it.
    assert {s.id for s in ws.project.sources} >= sources
    assert sorted(p.name for p in (root / "raw").iterdir()) == files
    placed = [c for c in ws.project.clips if c.source_id.startswith("rec-")]
    assert [c.source_id for c in placed] == [row.takes[0].source_id]


def test_undo_of_accept_brings_every_take_back_and_redo_discards_again(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    before = _everything(ws)
    _svc(ws).accept(sid, take_index=0)
    accepted = _everything(ws)
    history = HistoryService(ws)
    history.undo()
    assert _everything(ws) == before
    row = _row(ws)
    assert (row.status, [t.take_index for t in row.takes]) == ("pending", [0, 1, 2])
    history.redo()
    assert _everything(ws) == accepted
    assert {t.take_index for t in _row(ws).takes} == {0}


def test_undo_of_a_pick_then_of_accept_restores_each_step(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    _svc(ws).select_take(sid, 0)
    picked = _everything(ws)
    _svc(ws).accept(sid)
    history = HistoryService(ws)
    history.undo()
    assert _everything(ws) == picked
    assert (_row(ws).selected_take, len(_row(ws).takes)) == (0, 3)
    history.undo()
    assert _row(ws).selected_take is None


def test_with_one_take_accept_changes_nothing_about_the_staged_rows(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    staged = [t.model_dump() for t in _row(ws).takes]
    result = _svc(ws).accept(sid)
    assert result["discarded_takes"] == []
    assert [t.model_dump() for t in _row(ws).takes] == staged


def test_an_insert_places_and_keeps_all_its_takes(ws) -> None:
    sid = _insert(ws, 4.0, [1.0, 1.5])
    result = _svc(ws).accept(sid)
    assert "discarded_takes" not in result
    assert len(_row(ws).takes) == 2


def test_a_preview_leaves_the_other_takes_staged(ws) -> None:
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    _hear(ws, sid, mode="suggested", take_index=0)
    assert {t.take_index for t in _row(ws).takes} == {0, 1, 2}


# --- the carried notes ---


def test_accept_naming_override_holds_names_the_way_and_applies_when_told(ws) -> None:
    _words(ws, "guest", ("so", 2.5, 2.8))
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 1.0)]})
    held = _svc(ws).accept_naming_override(sid)
    assert held["unchanged"] is True
    message = held["needs_confirmation"]["message"]
    assert message.startswith('Replacing this range also removes 1 word from Guest: "so".')
    assert message.endswith(APPLY_ANYWAY)
    assert _row(ws).status == "pending"
    applied = _svc(ws).accept_naming_override(sid, override_audio_checks=True)
    assert "needs_confirmation" not in applied
    ws.reload()
    [record] = ws.project.editorial.edit_log
    assert record.params["audio_check_override"]["surface"] == "host_mcp"


def test_accept_naming_override_adds_nothing_to_a_plain_accept(ws) -> None:
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 1.0)]})
    plain = _svc(ws).accept_naming_override(sid)
    assert "needs_confirmation" not in plain
    assert plain["take_index"] == 0


@pytest.mark.parametrize("bad", ["1.5", None, True, [1], math.nan, math.inf, -0.1, 10.5])
def test_a_pad_that_is_not_a_number_of_seconds_is_pad_sec_invalid(ws, bad) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    with pytest.raises(CodedValueError) as refused:
        _svc(ws).preview(sid, pad_sec=bad, dry_run=True)
    assert refused.value.code == "pad_sec_invalid"
    assert "from 0 to 10" in str(refused.value)


@pytest.mark.parametrize("bad", ["0.4", None, False, math.nan, 5.5])
def test_a_gap_that_is_not_a_number_of_seconds_is_gap_sec_invalid(ws, bad) -> None:
    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    with pytest.raises(CodedValueError) as refused:
        _svc(ws).preview(sid, gap_sec=bad, dry_run=True)
    assert refused.value.code == "gap_sec_invalid"
    assert "from 0 to 5" in str(refused.value)


def test_the_limits_are_named_by_the_cli_help_and_the_mcp_docstring() -> None:
    from podcast_mcp.mcp.tools.review import hear_session_suggestion_tool

    doc = hear_session_suggestion_tool.__doc__ or ""
    assert "pad_sec_invalid" in doc and "gap_sec_invalid" in doc and "0 to 10" in doc
    helped = CLI.invoke(cli_app, ["review", "preview-session-suggestion", "--help"])
    assert "pad_sec_invalid" in helped.output.replace("\n", " ")
    assert "gap_sec_invalid" in helped.output.replace("\n", " ")


def test_a_collapsed_range_has_its_own_words_not_the_stale_anchor_ones(ws, monkeypatch) -> None:
    from podcast_mcp.edits import insert_anchor

    sid = _replace(ws, 3.0, 5.0, {0: [("host", 0.0, 2.0)]})
    monkeypatch.setattr(insert_anchor, "resolve_insert_anchor", lambda _p, _a: 3.0)
    with pytest.raises(CodedValueError) as collapsed:
        resolve_range(ws.project, _row(ws))
    assert collapsed.value.code == "stale_anchor"
    assert "has been cut away" in str(collapsed.value)
    assert "no longer on the timeline" not in str(collapsed.value)
    assert sid


def test_the_reworded_accept_messages_are_pinned(ws) -> None:
    from podcast_mcp.edits.transcript_refine_status import (
        REFINE_GATE,
        TranscriptRefineRequiredError,
    )
    from podcast_mcp.services.document.session_suggestion import REPLACE_REFINE_HINT

    assert "then try again." in REPLACE_REFINE_HINT
    assert "accept again" not in REPLACE_REFINE_HINT
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    with (
        patch.object(REFINE_GATE, "assert_clear", side_effect=TranscriptRefineRequiredError("x")),
        pytest.raises(TranscriptRefineRequiredError) as gated,
    ):
        _svc(ws).accept(sid)
    assert str(gated.value) == REPLACE_REFINE_HINT
    unknown = _refused(ws, sid, 5)
    assert str(unknown) == "Session 1 has no take 5. Pick one of: 0, 1, 2."
    _svc(ws).skip(sid)
    done = _refused(ws, sid, 0)
    assert str(done) == (
        "Session 1 was already skipped, so it cannot be changed again. "
        "Undo that step first if you want it back, or record a new session."
    )
    ws.mutate("clear", "cleared", lambda p: setattr(p.editorial, "session_suggestions", []))
    insert = _insert(ws, 4.0, [1.0])
    with pytest.raises(CodedValueError) as inserted:
        _svc(ws).accept(insert, take_index=0)
    assert str(inserted.value) == (
        "Session 1 is an insert, whose takes play one after another, so a take cannot be "
        "chosen. Accept it without a take."
    )


def test_pending_edits_in_range_says_to_try_again(ws) -> None:
    from test_record_session_preview import _pending_edit

    sid = _pending_edit(ws)
    with pytest.raises(CodedValueError) as held:
        _svc(ws).accept(sid, override_audio_checks=True)
    assert held.value.code == "pending_edits_in_range"
    assert str(held.value).endswith("Approve or reject them first, then try again.")


# --- surfaces ---


def test_cli_lists_and_picks_and_the_footer_says_replace(ws, minimal_project) -> None:
    _words(ws, "guest", ("so", 2.5, 2.8))
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 1.0)], 1: [("host", 0.0, 3.0)]})
    base = ["--project", str(minimal_project), "--id", sid]
    listed = CLI.invoke(cli_app, ["review", "session-takes", *base])
    assert listed.exit_code == 0, listed.output
    assert json.loads(listed.output)["default_take"] == 1
    picked = CLI.invoke(cli_app, ["review", "select-session-take", *base, "--take", "0"])
    assert picked.exit_code == 0, picked.output
    assert json.loads(picked.output)["selected_take"] == 0
    held = CLI.invoke(cli_app, ["review", "accept-session-suggestion", *base])
    assert held.exit_code == 1
    assert "To apply this replace as is" in held.output
    assert "this cut" not in held.output
    refused = CLI.invoke(cli_app, ["review", "select-session-take", *base, "--take", "9"])
    assert refused.exit_code == 1
    assert "take_not_found" in refused.output


def test_the_cut_command_footer_still_says_this_cut() -> None:
    import typer

    from podcast_mcp.cli.cut_speech import require_cut_applied

    with pytest.raises(typer.Exit):
        require_cut_applied(lambda: {"needs_confirmation": {"message": "held"}})


def test_mcp_lists_and_picks(ws, minimal_project) -> None:
    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    listed = json.loads(list_session_takes_tool(str(minimal_project), sid))
    assert listed["default_take"] == 2
    picked = json.loads(select_session_take_tool(str(minimal_project), sid, 0))
    assert picked["selected_take"] == 0
    accepted = json.loads(accept_session_suggestion_tool(str(minimal_project), sid))
    assert (accepted["take_index"], accepted["discarded_takes"]) == (0, [1, 2])


def test_the_gui_routes_list_and_pick(ws) -> None:
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    sid = _replace(ws, 3.0, 5.0, THREE_TAKES)
    client = TestClient(create_app())
    query = {"path": str(ws.path), "suggestion_id": sid}
    listed = client.get("/api/session-suggestion/takes", params=query)
    assert listed.status_code == 200, listed.text
    assert listed.json()["default_take"] == 2
    picked = client.post("/api/session-suggestion/select-take", params={**query, "take_index": 1})
    assert picked.status_code == 200, picked.text
    assert client.get("/api/session-suggestion/takes", params=query).json()["default_take"] == 1
    refused = client.post("/api/session-suggestion/select-take", params={**query, "take_index": 8})
    assert refused.status_code == 400
    assert refused.headers["X-Sharecut-Error-Code"] == "take_not_found"
    missing = client.get(
        "/api/session-suggestion/takes", params={"path": str(ws.path), "suggestion_id": "ss-no"}
    )
    assert missing.status_code == 404
    assert missing.headers["X-Sharecut-Error-Code"] == "session_suggestion_not_found"
