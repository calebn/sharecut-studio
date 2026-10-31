"""``SetRecordSessionName``: name a landed record session, clear it, undo it, host only."""

from __future__ import annotations

import pytest

from podcast_mcp.models import RECORD_SESSION_NAME_MAX_CHARS
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
from podcast_mcp.services.record import list_record_sessions
from podcast_mcp.util.coded_error import CodedValueError
from test_record_landing import _isolate, _land_session, _seed


@pytest.fixture
def landed(minimal_project, sample_wav, tmp_workspace):
    _isolate()
    ws = _seed(minimal_project, sample_wav)
    room, _ = _land_session(ws, take_ms=3_000)
    return ws, room["session_id"]


def _name(ws, sid):
    return next(i for i in list_record_sessions(ws.project) if i["session_id"] == sid)["name"]


def test_a_landed_session_has_no_name_until_set(landed):
    ws, sid = landed
    assert _name(ws, sid) is None


def test_set_trims_and_the_read_model_returns_it(landed):
    ws, sid = landed
    out = apply_command(ws, "SetRecordSessionName", {"session_id": sid, "name": "  Cold open \n"})
    assert out == {"session_id": sid, "name": "Cold open"}
    assert _name(ws, sid) == "Cold open"


@pytest.mark.parametrize("blank", ["", "   \t\n"])
def test_empty_or_blank_clears_the_name(landed, blank):
    ws, sid = landed
    apply_command(ws, "SetRecordSessionName", {"session_id": sid, "name": "Cold open"})
    out = apply_command(ws, "SetRecordSessionName", {"session_id": sid, "name": blank})
    assert out["name"] is None
    assert _name(ws, sid) is None


def test_the_longest_name_is_kept(landed):
    ws, sid = landed
    name = "n" * RECORD_SESSION_NAME_MAX_CHARS
    apply_command(ws, "SetRecordSessionName", {"session_id": sid, "name": name})
    assert _name(ws, sid) == name


@pytest.mark.parametrize("name", ["x" * (RECORD_SESSION_NAME_MAX_CHARS + 1), "bad\x00name"])
def test_an_invalid_name_is_refused_and_changes_nothing(landed, name):
    ws, sid = landed
    with pytest.raises(CodedValueError) as err:
        apply_command(ws, "SetRecordSessionName", {"session_id": sid, "name": name})
    assert err.value.code == "invalid_session_name"
    assert _name(ws, sid) is None


def test_an_unknown_session_is_refused(landed):
    ws, _sid = landed
    with pytest.raises(CodedValueError) as err:
        apply_command(ws, "SetRecordSessionName", {"session_id": "nope", "name": "x"})
    assert err.value.code == "record_session_unknown"


def test_the_rename_is_one_undo_step(landed):
    ws, sid = landed
    apply_command(ws, "SetRecordSessionName", {"session_id": sid, "name": "First"})
    apply_command(ws, "SetRecordSessionName", {"session_id": sid, "name": "Second"})
    HistoryService(ws).undo()
    assert _name(ws, sid) == "First"
    HistoryService(ws).undo()
    assert _name(ws, sid) is None
    HistoryService(ws).redo()
    assert _name(ws, sid) == "First"


def test_the_command_validates_as_an_envelope():
    body = DOCUMENT_COMMAND_ADAPTER.validate_python(
        {
            "type": "SetRecordSessionName",
            "payload": {"session_id": "abc", "name": "Pilot"},
            "client_id": "c1",
            "client_seq": 1,
        }
    )
    assert body.payload.name == "Pilot"


def test_only_the_host_names_a_session():
    assert "SetRecordSessionName" in HOST_ONLY_DOCUMENT_COMMANDS
    assert "SetRecordSessionName" not in EDIT_COMMANDS
    authorize_document_command(None, "SetRecordSessionName")
    for role in ("editor", "commenter", "viewer"):
        caps = capabilities_for_role(role)
        assert "SetRecordSessionName" not in document_command_types_for_caps(caps)
        with pytest.raises(PermissionError) as raised:
            authorize_document_command(caps, "SetRecordSessionName")
        assert raised.value.code == "share_capability_required"
