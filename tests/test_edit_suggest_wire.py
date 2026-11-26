"""Pin the exact wire output of EditService.suggest_pending_edit on every surface that forwards it."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from edit_wire_helpers import build_workspace, normalize
from podcast_mcp.cli.main import app
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools import document as document_tools
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document_sync import host_command_result, submit_host_document_command
from podcast_mcp.services.document_sync.handlers import markers
from podcast_mcp.util.coded_error import CodedError

pytestmark = pytest.mark.unscoped_ok

_COMMAND = "SuggestPendingEdit"

_CASES: dict[str, dict[str, Any]] = {
    "remove-default": {"track_id": "host", "start": 1.0, "end": 1.4},
    "remove-with-reason": {"track_id": "host", "start": 1.0, "end": 1.4, "reason": "too long"},
    "remove-explicit": {"track_id": "host", "start": 1.0, "end": 1.4, "edit_type": "remove"},
    "remove-wide-range": {"track_id": "host", "start": 0.5, "end": 3.5},
    "remove-no-words-in-range": {"track_id": "host", "start": 5.0, "end": 5.4},
    "mute-default": {"track_id": "host", "start": 1.0, "end": 1.4, "edit_type": "mute"},
    "mute-with-reason": {
        "track_id": "host",
        "start": 1.0,
        "end": 1.4,
        "edit_type": "mute",
        "reason": "cough",
    },
    "track-without-words-over-peer-speech": {"track_id": "guest", "start": 1.0, "end": 1.4},
    "track-without-words-quiet-range": {"track_id": "guest", "start": 5.0, "end": 5.4},
    "mute-on-track-without-words": {
        "track_id": "guest",
        "start": 5.0,
        "end": 5.4,
        "edit_type": "mute",
    },
    "integral-bounds": {"track_id": "host", "start": 2, "end": 3},
}
_AUTHORED = {
    "remove-with-author": {"track_id": "host", "start": 1.0, "end": 1.4, "author": "Bob"},
    "mute-with-reason-and-author": {
        "track_id": "host",
        "start": 1.0,
        "end": 1.4,
        "edit_type": "mute",
        "reason": "cough",
        "author": "Bob",
    },
}
_ERRORS: dict[str, dict[str, Any]] = {
    "edit-type-invalid": {"track_id": "host", "start": 1.0, "end": 1.4, "edit_type": "cut"},
    "edit-type-padded-invalid": {
        "track_id": "host",
        "start": 1.0,
        "end": 1.4,
        "edit_type": " cut ",
    },
    "unknown-track": {"track_id": "nobody", "start": 1.0, "end": 1.4},
    "end-before-start": {"track_id": "host", "start": 2.0, "end": 1.0},
    "end-equals-start": {"track_id": "host", "start": 2.0, "end": 2.0},
    "beyond-the-timeline": {"track_id": "host", "start": 10.0, "end": 11.0},
}

_EXPECTED: dict[str, dict[str, Any]] = {
    "remove-default": {
        "applied": False,
        "author": None,
        "boundary_intent": "programmatic",
        "boundary_mode": None,
        "crossfade_ms": 10,
        "cut_confidence": None,
        "cut_speech": None,
        "end": 1.4,
        "exact_range": None,
        "id": "<cut:0>",
        "next_burst_sec": None,
        "proposal_origin": "programmatic",
        "reason": "guest:suggest",
        "replace_gap_sec": None,
        "review_required": True,
        "scope": "session",
        "source_id": None,
        "source_timeline_span": None,
        "start": 1.0,
        "timebase": "source",
        "track_id": "host",
        "track_ids": None,
        "type": "remove",
    },
    "remove-with-reason": {
        "applied": False,
        "author": None,
        "boundary_intent": "programmatic",
        "boundary_mode": None,
        "crossfade_ms": 10,
        "cut_confidence": None,
        "cut_speech": None,
        "end": 1.4,
        "exact_range": None,
        "id": "<cut:0>",
        "next_burst_sec": None,
        "proposal_origin": "programmatic",
        "reason": "too long",
        "replace_gap_sec": None,
        "review_required": True,
        "scope": "session",
        "source_id": None,
        "source_timeline_span": None,
        "start": 1.0,
        "timebase": "source",
        "track_id": "host",
        "track_ids": None,
        "type": "remove",
    },
    "remove-explicit": {
        "applied": False,
        "author": None,
        "boundary_intent": "programmatic",
        "boundary_mode": None,
        "crossfade_ms": 10,
        "cut_confidence": None,
        "cut_speech": None,
        "end": 1.4,
        "exact_range": None,
        "id": "<cut:0>",
        "next_burst_sec": None,
        "proposal_origin": "programmatic",
        "reason": "guest:suggest",
        "replace_gap_sec": None,
        "review_required": True,
        "scope": "session",
        "source_id": None,
        "source_timeline_span": None,
        "start": 1.0,
        "timebase": "source",
        "track_id": "host",
        "track_ids": None,
        "type": "remove",
    },
    "remove-wide-range": {
        "applied": False,
        "author": None,
        "boundary_intent": "programmatic",
        "boundary_mode": None,
        "crossfade_ms": 10,
        "cut_confidence": None,
        "cut_speech": None,
        "end": 3.5,
        "exact_range": None,
        "id": "<cut:0>",
        "next_burst_sec": None,
        "proposal_origin": "programmatic",
        "reason": "guest:suggest",
        "replace_gap_sec": None,
        "review_required": True,
        "scope": "session",
        "source_id": None,
        "source_timeline_span": None,
        "start": 0.5,
        "timebase": "source",
        "track_id": "host",
        "track_ids": None,
        "type": "remove",
    },
    "remove-no-words-in-range": {
        "applied": False,
        "author": None,
        "boundary_intent": "programmatic",
        "boundary_mode": None,
        "crossfade_ms": 10,
        "cut_confidence": None,
        "cut_speech": None,
        "end": 5.4,
        "exact_range": None,
        "id": "<cut:0>",
        "next_burst_sec": None,
        "proposal_origin": "programmatic",
        "reason": "guest:suggest",
        "replace_gap_sec": None,
        "review_required": True,
        "scope": "session",
        "source_id": None,
        "source_timeline_span": None,
        "start": 5.0,
        "timebase": "source",
        "track_id": "host",
        "track_ids": None,
        "type": "remove",
    },
    "mute-default": {
        "applied": False,
        "author": None,
        "boundary_intent": "programmatic",
        "boundary_mode": None,
        "crossfade_ms": 10,
        "cut_confidence": None,
        "cut_speech": None,
        "end": 1.4,
        "exact_range": None,
        "id": "<cut:0>",
        "next_burst_sec": None,
        "proposal_origin": "programmatic",
        "reason": "guest:suggest",
        "replace_gap_sec": None,
        "review_required": True,
        "scope": "session",
        "source_id": None,
        "source_timeline_span": None,
        "start": 1.0,
        "timebase": "source",
        "track_id": "host",
        "track_ids": None,
        "type": "mute",
    },
    "mute-with-reason": {
        "applied": False,
        "author": None,
        "boundary_intent": "programmatic",
        "boundary_mode": None,
        "crossfade_ms": 10,
        "cut_confidence": None,
        "cut_speech": None,
        "end": 1.4,
        "exact_range": None,
        "id": "<cut:0>",
        "next_burst_sec": None,
        "proposal_origin": "programmatic",
        "reason": "cough",
        "replace_gap_sec": None,
        "review_required": True,
        "scope": "session",
        "source_id": None,
        "source_timeline_span": None,
        "start": 1.0,
        "timebase": "source",
        "track_id": "host",
        "track_ids": None,
        "type": "mute",
    },
    "track-without-words-over-peer-speech": {
        "applied": False,
        "author": None,
        "boundary_intent": "programmatic",
        "boundary_mode": None,
        "crossfade_ms": 10,
        "cut_confidence": None,
        "cut_speech": None,
        "end": 1.4,
        "exact_range": None,
        "id": "<cut:0>",
        "next_burst_sec": None,
        "proposal_origin": "programmatic",
        "reason": "guest:suggest:acoustic_review:peer_speech",
        "replace_gap_sec": None,
        "review_required": True,
        "scope": "session",
        "source_id": None,
        "source_timeline_span": None,
        "start": 1.0,
        "timebase": "source",
        "track_id": "guest",
        "track_ids": None,
        "type": "remove",
    },
    "track-without-words-quiet-range": {
        "applied": False,
        "author": None,
        "boundary_intent": "programmatic",
        "boundary_mode": None,
        "crossfade_ms": 10,
        "cut_confidence": None,
        "cut_speech": None,
        "end": 5.4,
        "exact_range": None,
        "id": "<cut:0>",
        "next_burst_sec": None,
        "proposal_origin": "programmatic",
        "reason": "guest:suggest",
        "replace_gap_sec": None,
        "review_required": True,
        "scope": "session",
        "source_id": None,
        "source_timeline_span": None,
        "start": 5.0,
        "timebase": "source",
        "track_id": "guest",
        "track_ids": None,
        "type": "remove",
    },
    "mute-on-track-without-words": {
        "applied": False,
        "author": None,
        "boundary_intent": "programmatic",
        "boundary_mode": None,
        "crossfade_ms": 10,
        "cut_confidence": None,
        "cut_speech": None,
        "end": 5.4,
        "exact_range": None,
        "id": "<cut:0>",
        "next_burst_sec": None,
        "proposal_origin": "programmatic",
        "reason": "guest:suggest",
        "replace_gap_sec": None,
        "review_required": True,
        "scope": "session",
        "source_id": None,
        "source_timeline_span": None,
        "start": 5.0,
        "timebase": "source",
        "track_id": "guest",
        "track_ids": None,
        "type": "mute",
    },
    "integral-bounds": {
        "applied": False,
        "author": None,
        "boundary_intent": "programmatic",
        "boundary_mode": None,
        "crossfade_ms": 10,
        "cut_confidence": None,
        "cut_speech": None,
        "end": 3.0,
        "exact_range": None,
        "id": "<cut:0>",
        "next_burst_sec": None,
        "proposal_origin": "programmatic",
        "reason": "guest:suggest",
        "replace_gap_sec": None,
        "review_required": True,
        "scope": "session",
        "source_id": None,
        "source_timeline_span": None,
        "start": 2.0,
        "timebase": "source",
        "track_id": "host",
        "track_ids": None,
        "type": "remove",
    },
}
_EXPECTED_AUTHORED: dict[str, dict[str, Any]] = {
    "remove-with-author": {
        "applied": False,
        "author": "Bob",
        "boundary_intent": "programmatic",
        "boundary_mode": None,
        "crossfade_ms": 10,
        "cut_confidence": None,
        "cut_speech": None,
        "end": 1.4,
        "exact_range": None,
        "id": "<cut:0>",
        "next_burst_sec": None,
        "proposal_origin": "programmatic",
        "reason": "guest:suggest",
        "replace_gap_sec": None,
        "review_required": True,
        "scope": "session",
        "source_id": None,
        "source_timeline_span": None,
        "start": 1.0,
        "timebase": "source",
        "track_id": "host",
        "track_ids": None,
        "type": "remove",
    },
    "mute-with-reason-and-author": {
        "applied": False,
        "author": "Bob",
        "boundary_intent": "programmatic",
        "boundary_mode": None,
        "crossfade_ms": 10,
        "cut_confidence": None,
        "cut_speech": None,
        "end": 1.4,
        "exact_range": None,
        "id": "<cut:0>",
        "next_burst_sec": None,
        "proposal_origin": "programmatic",
        "reason": "cough",
        "replace_gap_sec": None,
        "review_required": True,
        "scope": "session",
        "source_id": None,
        "source_timeline_span": None,
        "start": 1.0,
        "timebase": "source",
        "track_id": "host",
        "track_ids": None,
        "type": "mute",
    },
}
_EXPECTED_ERRORS: dict[str, dict[str, dict[str, Any]]] = {
    "edit-type-invalid": {
        "service": {
            "class": "CodedValueError",
            "code": "edit_type_invalid",
            "message": "edit_type must be remove or mute",
        },
        "handler": {
            "class": "CodedValueError",
            "code": "edit_type_invalid",
            "message": "edit_type must be remove or mute",
        },
        "host": {
            "class": "ValidationError",
            "code": None,
            "message": "1 validation error for SuggestPendingEditPayload\nedit_type\n  Input should be 'remove' or 'mute' [type=literal_error, input_value='cut', input_type=str]",
        },
        "mcp": {
            "class": "CodedValueError",
            "code": "invalid_payload",
            "message": "SuggestPendingEdit: edit_type: Input should be 'remove' or 'mute'",
        },
    },
    "edit-type-padded-invalid": {
        "service": {
            "class": "CodedValueError",
            "code": "edit_type_invalid",
            "message": "edit_type must be remove or mute",
        },
        "handler": {
            "class": "CodedValueError",
            "code": "edit_type_invalid",
            "message": "edit_type must be remove or mute",
        },
        "host": {
            "class": "ValidationError",
            "code": None,
            "message": "1 validation error for SuggestPendingEditPayload\nedit_type\n  Input should be 'remove' or 'mute' [type=literal_error, input_value=' cut ', input_type=str]",
        },
        "mcp": {
            "class": "CodedValueError",
            "code": "invalid_payload",
            "message": "SuggestPendingEdit: edit_type: Input should be 'remove' or 'mute'",
        },
    },
    "unknown-track": {
        "service": {
            "class": "ScopeChangedAtApproval",
            "code": "cut_scope_changed",
            "message": "nobody's cut at 0:01.0 was not applied because the selected audio no longer has one complete, continuous placement. Select the part to cut on the timeline, or reject the held cuts.",
        },
        "handler": {
            "class": "ScopeChangedAtApproval",
            "code": "cut_scope_changed",
            "message": "nobody's cut at 0:01.0 was not applied because the selected audio no longer has one complete, continuous placement. Select the part to cut on the timeline, or reject the held cuts.",
        },
        "host": {
            "class": "ScopeChangedAtApproval",
            "code": "cut_scope_changed",
            "message": "nobody's cut at 0:01.0 was not applied because the selected audio no longer has one complete, continuous placement. Select the part to cut on the timeline, or reject the held cuts.",
        },
        "mcp": {
            "class": "ScopeChangedAtApproval",
            "code": "cut_scope_changed",
            "message": "nobody's cut at 0:01.0 was not applied because the selected audio no longer has one complete, continuous placement. Select the part to cut on the timeline, or reject the held cuts.",
        },
    },
    "end-before-start": {
        "service": {
            "class": "CodedValueError",
            "code": "range_end_before_start",
            "message": "end must be greater than start. Pick an end after the start.",
        },
        "handler": {
            "class": "CodedValueError",
            "code": "range_end_before_start",
            "message": "end must be greater than start. Pick an end after the start.",
        },
        "host": {
            "class": "ValidationError",
            "code": None,
            "message": "1 validation error for SuggestPendingEditPayload\n  Value error, end must be after start [type=value_error, input_value={'track_id': 'host', 'start': 2.0, 'end': 1.0}, input_type=dict]",
        },
        "mcp": {
            "class": "CodedValueError",
            "code": "invalid_payload",
            "message": "SuggestPendingEdit: payload: Value error, end must be after start",
        },
    },
    "end-equals-start": {
        "service": {
            "class": "CodedValueError",
            "code": "range_end_before_start",
            "message": "end must be greater than start. Pick an end after the start.",
        },
        "handler": {
            "class": "CodedValueError",
            "code": "range_end_before_start",
            "message": "end must be greater than start. Pick an end after the start.",
        },
        "host": {
            "class": "ValidationError",
            "code": None,
            "message": "1 validation error for SuggestPendingEditPayload\n  Value error, end must be after start [type=value_error, input_value={'track_id': 'host', 'start': 2.0, 'end': 2.0}, input_type=dict]",
        },
        "mcp": {
            "class": "CodedValueError",
            "code": "invalid_payload",
            "message": "SuggestPendingEdit: payload: Value error, end must be after start",
        },
    },
    "beyond-the-timeline": {
        "service": {
            "class": "ScopeChangedAtApproval",
            "code": "cut_scope_changed",
            "message": "Host's cut at 0:10.0 was not applied because the selected audio no longer has one complete, continuous placement. Select the part to cut on the timeline, or reject the held cuts.",
        },
        "handler": {
            "class": "ScopeChangedAtApproval",
            "code": "cut_scope_changed",
            "message": "Host's cut at 0:10.0 was not applied because the selected audio no longer has one complete, continuous placement. Select the part to cut on the timeline, or reject the held cuts.",
        },
        "host": {
            "class": "ScopeChangedAtApproval",
            "code": "cut_scope_changed",
            "message": "Host's cut at 0:10.0 was not applied because the selected audio no longer has one complete, continuous placement. Select the part to cut on the timeline, or reject the held cuts.",
        },
        "mcp": {
            "class": "ScopeChangedAtApproval",
            "code": "cut_scope_changed",
            "message": "Host's cut at 0:10.0 was not applied because the selected audio no longer has one complete, continuous placement. Select the part to cut on the timeline, or reject the held cuts.",
        },
    },
}
_EXPECTED_CLI_ERRORS: dict[str, tuple[int, str]] = {
    "edit-type-invalid": (
        1,
        "SuggestPendingEdit: edit_type: Input should be 'remove' or 'mute' (code invalid_payload)\n",
    ),
    "unknown-track": (
        1,
        "nobody's cut at 0:01.0 was not applied because the selected audio no longer has one complete, continuous placement. Select the part to cut on the timeline, or reject the held cuts. (code cut_scope_changed)\n",
    ),
}


def _service(ws: ProjectWorkspace, args: dict[str, Any]) -> Any:
    rest = {k: v for k, v in args.items() if k not in ("track_id", "start", "end")}
    return EditService(ws).suggest_pending_edit(
        args["track_id"], args["start"], args["end"], **rest
    )


def _payload(args: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in args.items() if k != "author"}


def _handler(ws: ProjectWorkspace, args: dict[str, Any]) -> Any:
    payload = _payload(args)
    if "author" in args:
        payload["_author"] = args["author"]
    return markers.suggest_pending_edit(ws, payload)


def _host(ws: ProjectWorkspace, args: dict[str, Any]) -> Any:
    return host_command_result(submit_host_document_command(ws.path, _COMMAND, _payload(args)))


def _mcp(ws: ProjectWorkspace, args: dict[str, Any]) -> Any:
    reply = document_tools.submit_document_command_tool(str(ws.path), _COMMAND, _payload(args))
    return json.loads(reply)["result"]


def _cli(ws: ProjectWorkspace, args: dict[str, Any]) -> Any:
    result = CliRunner().invoke(
        app,
        [
            "doc",
            "submit",
            _COMMAND,
            "--project",
            str(ws.path),
            "--payload",
            json.dumps(_payload(args)),
        ],
    )
    assert result.exit_code == 0, result.output
    return json.loads(result.output)["result"]


def _web(ws: ProjectWorkspace, args: dict[str, Any]) -> Any:
    with TestClient(create_app()) as client:
        reply = client.post(
            f"/api/document/command?path={quote(str(ws.path))}",
            json={
                "type": _COMMAND,
                "payload": _payload(args),
                "client_id": "wire",
                "client_seq": 1,
            },
        )
    assert reply.status_code == 200, reply.text
    return reply.json()["command"]["payload"]["result"]


_SURFACES = {
    "service": _service,
    "handler": _handler,
    "host": _host,
    "mcp": _mcp,
    "cli": _cli,
    "web": _web,
}
_ATTEMPTS = {"service": _service, "handler": _handler, "host": _host, "mcp": _mcp}
_DOC_URL = "\n    For further information"


@pytest.mark.parametrize("surface", list(_SURFACES))
@pytest.mark.parametrize("name", list(_CASES))
def test_suggest_pending_edit_wire(tmp_path, name, surface):
    ws = build_workspace(tmp_path)
    result = _SURFACES[surface](ws, _CASES[name])
    assert normalize(result, ws) == _EXPECTED[name]


@pytest.mark.parametrize("surface", ["service", "handler"])
@pytest.mark.parametrize("name", list(_AUTHORED))
def test_suggest_pending_edit_author_wire(tmp_path, name, surface):
    ws = build_workspace(tmp_path)
    result = _SURFACES[surface](ws, _AUTHORED[name])
    assert normalize(result, ws) == _EXPECTED_AUTHORED[name]


def _failure(surface: str, ws: ProjectWorkspace, args: dict[str, Any]) -> dict[str, Any]:
    with pytest.raises(Exception) as caught:
        _ATTEMPTS[surface](ws, args)
    error = caught.value
    return {
        "class": type(error).__name__,
        "code": error.code if isinstance(error, CodedError) else None,
        "message": str(error).split(_DOC_URL)[0],
    }


@pytest.mark.parametrize("surface", list(_ATTEMPTS))
@pytest.mark.parametrize("name", list(_ERRORS))
def test_suggest_pending_edit_error_wire(tmp_path, name, surface):
    ws = build_workspace(tmp_path)
    before = ws.path.read_bytes()
    assert _failure(surface, ws, _ERRORS[name]) == _EXPECTED_ERRORS[name][surface]
    assert ws.path.read_bytes() == before


@pytest.mark.parametrize(
    ("edit_type", "stored"), [(None, "remove"), ("", "remove"), (" Mute ", "mute")]
)
def test_edit_type_is_trimmed_lowercased_and_defaults_to_remove(tmp_path, edit_type, stored):
    ws = build_workspace(tmp_path)
    result = EditService(ws).suggest_pending_edit("host", 1.0, 1.4, edit_type=edit_type)
    assert result["type"] == stored


def test_a_suggestion_is_stored_as_a_pending_review_decision(tmp_path):
    ws = build_workspace(tmp_path)
    result = EditService(ws).suggest_pending_edit("host", 1.0, 1.4, edit_type="mute", author="Bob")
    stored = ProjectWorkspace.open(ws.path).project.edit_decisions[-1]
    assert stored.id == result["id"]
    assert stored.review_required is True
    assert stored.applied is False
    assert "bound_pad" not in result


def test_cli_doc_submit_error_text(tmp_path):
    ws = build_workspace(tmp_path)
    before = ws.path.read_bytes()
    texts = {}
    for name in ("edit-type-invalid", "unknown-track"):
        payload = json.dumps(_ERRORS[name])
        result = CliRunner().invoke(
            app, ["doc", "submit", _COMMAND, "--project", str(ws.path), "--payload", payload]
        )
        texts[name] = (result.exit_code, result.output)
    assert texts == _EXPECTED_CLI_ERRORS
    assert ws.path.read_bytes() == before
