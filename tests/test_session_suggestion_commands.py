"""GUI payload ``session_suggestions`` and the host-only Accept/Skip/Select session commands."""

from __future__ import annotations

import pytest

from podcast_mcp.gui.assembler import build_project_view
from podcast_mcp.services.collaboration.share import sanitize_guest_project_view
from podcast_mcp.services.collaboration.share_capabilities import capabilities_for_role
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.document_sync.capabilities import (
    EDIT_COMMANDS,
    HOST_ONLY_DOCUMENT_COMMANDS,
    authorize_document_command,
    document_command_types_for_caps,
)
from podcast_mcp.services.document_sync.handlers import apply_command
from podcast_mcp.services.document_sync.payloads import DOCUMENT_COMMAND_ADAPTER
from podcast_mcp.util.coded_error import CodedValueError
from test_record_replace_accept import SID, _seed_two_speakers, _stage_replace, _words
from test_record_staging import INSERT, _everything, _seed, _seed_timeline, _stage, _suggestion

COMMANDS = ("AcceptSessionSuggestion", "SkipSessionSuggestion", "SelectSessionTake")
TAKE = {0: [("host", 0.0, 3.0)]}


@pytest.fixture
def ws(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    monkeypatch.setattr(
        "podcast_mcp.edits.cut_speech.speech_energy_guard_enabled", lambda _defaults: False
    )
    workspace = _seed(minimal_project, sample_wav)
    _seed_two_speakers(workspace)
    return workspace


def _view(ws) -> dict:
    return build_project_view(ws).model_dump()


def _titles(ws) -> list[str]:
    return [g.title for g in HistoryService(ws).list_entries().groups]


def test_payload_lists_only_pending_suggestions_as_a_small_view(ws) -> None:
    pending = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)], 1: [("host", 0.0, 2.0)]})
    decided = _stage_replace(ws, 6.0, 7.0, TAKE, session_id="b" * 12, number=2)
    apply_command(ws, "SkipSessionSuggestion", {"suggestion_id": decided})
    assert _view(ws)["session_suggestions"] == [
        {
            "id": pending,
            "kind": "replace",
            "session_id": SID,
            "session_number": 1,
            "at_sec": None,
            "from_sec": 2.0,
            "to_sec": 4.0,
            "track_ids": ["host"],
            "take_count": 2,
            "selected_take": None,
        }
    ]
    apply_command(ws, "AcceptSessionSuggestion", {"suggestion_id": pending})
    assert _view(ws)["session_suggestions"] == []


def test_the_guest_payload_never_carries_suggestions(ws) -> None:
    _stage_replace(ws, 2.0, 4.0, TAKE)
    view = _view(ws)
    assert view["session_suggestions"]
    assert "session_suggestions" not in sanitize_guest_project_view(view)
    assert "session_suggestions" not in sanitize_guest_project_view(
        {"session_suggestions": view["session_suggestions"]}
    )


def test_accept_a_replace_returns_the_service_reply_and_is_one_undo_step(ws) -> None:
    sid = _stage_replace(ws, 2.0, 4.0, TAKE)
    before = _everything(ws)
    out = apply_command(ws, "AcceptSessionSuggestion", {"suggestion_id": sid, "take_index": 0})
    assert out["suggestion"]["status"] == "accepted"
    assert _titles(ws)[-1] == "Added Session 1"
    accepted = _everything(ws)
    HistoryService(ws).undo()
    assert _everything(ws) == before
    HistoryService(ws).redo()
    assert _everything(ws) == accepted


def test_accept_an_insert(minimal_project, sample_wav, tmp_workspace) -> None:
    ws = _seed(minimal_project, sample_wav)
    _seed_timeline(ws)
    room, _guest, _svc, _landed = _stage(ws, INSERT, takes=2)
    sid = f"ss-{room['session_id']}"
    before = _everything(ws)
    out = apply_command(ws, "AcceptSessionSuggestion", {"suggestion_id": sid})
    assert out["suggestion"]["status"] == "accepted"
    assert _suggestion(ws, room["session_id"]).status == "accepted"
    assert _titles(ws)[-1] == "Added Session 1"
    HistoryService(ws).undo()
    assert _everything(ws) == before
    assert _suggestion(ws, room["session_id"]).status == "pending"


def test_a_held_replace_replies_needs_confirmation_then_applies_with_the_override(ws) -> None:
    _words(ws, "guest", ("so", 2.5, 2.8), ("plan", 3.0, 3.4))
    sid = _stage_replace(ws, 2.0, 4.0, TAKE)
    before = _everything(ws)
    held = apply_command(ws, "AcceptSessionSuggestion", {"suggestion_id": sid})
    assert held["needs_confirmation"]["reason"] == "cuts_other_speech"
    assert _everything(ws) == before
    applied = apply_command(
        ws, "AcceptSessionSuggestion", {"suggestion_id": sid, "override_audio_checks": True}
    )
    assert applied["suggestion"]["status"] == "accepted"


def test_accept_refuses_a_suggestion_that_is_not_pending(ws) -> None:
    sid = _stage_replace(ws, 2.0, 4.0, TAKE)
    apply_command(ws, "SkipSessionSuggestion", {"suggestion_id": sid})
    done = _everything(ws)
    with pytest.raises(CodedValueError) as err:
        apply_command(ws, "AcceptSessionSuggestion", {"suggestion_id": sid})
    assert err.value.code == "session_suggestion_not_pending"
    assert _everything(ws) == done


def test_skip_is_one_undo_step(ws) -> None:
    sid = _stage_replace(ws, 2.0, 4.0, TAKE)
    before = _everything(ws)
    out = apply_command(ws, "SkipSessionSuggestion", {"suggestion_id": sid})
    assert out["status"] == "skipped"
    assert _titles(ws)[-1] == "Skipped Session 1"
    HistoryService(ws).undo()
    assert _everything(ws) == before
    assert _view(ws)["session_suggestions"][0]["id"] == sid
    apply_command(ws, "SkipSessionSuggestion", {"suggestion_id": sid})
    with pytest.raises(CodedValueError) as err:
        apply_command(ws, "SkipSessionSuggestion", {"suggestion_id": sid})
    assert err.value.code == "session_suggestion_not_pending"


def test_select_take_shows_in_the_payload_and_undoes(ws) -> None:
    sid = _stage_replace(ws, 2.0, 4.0, {0: [("host", 0.0, 3.0)], 1: [("host", 0.0, 2.0)]})
    apply_command(ws, "SelectSessionTake", {"suggestion_id": sid, "take_index": 0})
    assert _view(ws)["session_suggestions"][0]["selected_take"] == 0
    assert _titles(ws)[-1] == "Chose take 0 for Session 1"
    HistoryService(ws).undo()
    assert _view(ws)["session_suggestions"][0]["selected_take"] is None


def test_the_commands_validate_as_envelopes() -> None:
    body = DOCUMENT_COMMAND_ADAPTER.validate_python(
        {
            "type": "AcceptSessionSuggestion",
            "payload": {"suggestion_id": "ss-1"},
            "client_id": "c1",
            "client_seq": 1,
        }
    )
    assert body.payload.take_index is None
    assert body.payload.override_audio_checks is False


@pytest.mark.parametrize("command", COMMANDS)
def test_only_the_host_decides_a_staged_session(command: str) -> None:
    assert command in HOST_ONLY_DOCUMENT_COMMANDS
    assert command not in EDIT_COMMANDS
    authorize_document_command(None, command)
    for role in ("editor", "commenter", "viewer"):
        caps = capabilities_for_role(role)
        assert command not in document_command_types_for_caps(caps)
        with pytest.raises(PermissionError) as raised:
            authorize_document_command(caps, command)
        assert raised.value.code == "share_capability_required"
