"""Pin the exact wire output of EditService.revert_applied on every surface that forwards it."""

from __future__ import annotations

import itertools
import json
from typing import Any
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from edit_wire_helpers import applied_ids, build_workspace, dump, normalize
from podcast_mcp.cli.main import app
from podcast_mcp.gui.server import create_app
from podcast_mcp.mcp.tools import edits as edit_tools
from podcast_mcp.services.document import EditService
from podcast_mcp.services.document_sync import (
    DocumentSyncService,
    host_command_result,
    submit_host_document_command,
)
from podcast_mcp.services.document_sync.handlers import edits as edit_handlers

pytestmark = pytest.mark.unscoped_ok

_BOTH = {"approve": ("m1", "r1")}
_ALL = {"approve": ("m1", "r1"), "trim": True}
_PICK = {"m": 0, "r": 1, "t": 2}
_MISSING = "alog_missing"
_CLIENTS = itertools.count()

_SCENARIOS: dict[str, tuple[dict[str, Any], list[tuple[str, bool]]]] = {
    "plan-mute": (_BOTH, [("m", True)]),
    "plan-cut": (_BOTH, [("r", True)]),
    "plan-both": (_BOTH, [("mr", True)]),
    "plan-both-reversed": (_BOTH, [("rm", True)]),
    "restore-mute": (_BOTH, [("m", False)]),
    "restore-cut": (_BOTH, [("r", False)]),
    "restore-both": (_BOTH, [("mr", False)]),
    "restore-single-record": ({"approve": ("m1",)}, [("m", False)]),
    "unknown": (_BOTH, [("?", False)]),
    "plan-unknown": (_BOTH, [("?", True)]),
    "known-and-unknown": (_BOTH, [("m?", False)]),
    "history-only": (_ALL, [("t", False)]),
    "plan-history-only": (_ALL, [("t", True)]),
    "history-only-with-known": (_ALL, [("mt", False)]),
    "restore-twice": (_BOTH, [("m", False), ("m", False)]),
    "plan-then-restore": (_BOTH, [("m", True), ("m", False)]),
    "restore-then-other": (_BOTH, [("m", False), ("r", False)]),
    "nothing-applied": ({}, [("?", False)]),
}

_EXPECTED: dict[str, list[dict[str, Any]]] = {
    "plan-mute": [
        {
            "conflicts": [],
            "status": "planned",
            "summary": {
                "affected_tracks": ["host"],
                "ids": ["<alog:0>"],
                "operation": "revert_applied_edit",
            },
        }
    ],
    "plan-cut": [
        {
            "conflicts": [],
            "status": "planned",
            "summary": {
                "affected_tracks": ["host", "guest"],
                "ids": ["<alog:0>"],
                "operation": "revert_applied_edit",
            },
        }
    ],
    "plan-both": [
        {
            "conflicts": [],
            "status": "planned",
            "summary": {
                "affected_tracks": ["host", "guest"],
                "ids": ["<alog:0>", "<alog:1>"],
                "operation": "revert_applied_edit",
            },
        }
    ],
    "plan-both-reversed": [
        {
            "conflicts": [],
            "status": "planned",
            "summary": {
                "affected_tracks": ["host", "guest"],
                "ids": ["<alog:0>", "<alog:1>"],
                "operation": "revert_applied_edit",
            },
        }
    ],
    "restore-mute": [
        {
            "conflicts": [],
            "status": "restored",
            "summary": {
                "affected_tracks": ["host"],
                "clip_count": 4,
                "duration_sec": 0.0,
                "ids": ["<alog:0>"],
                "operation": "revert_applied_edit",
                "timeline_duration_sec": 5.6,
                "track_ids": ["host"],
            },
        }
    ],
    "restore-cut": [
        {
            "conflicts": [],
            "status": "restored",
            "summary": {
                "affected_tracks": ["host", "guest"],
                "clip_count": 6,
                "duration_sec": 0.0,
                "ids": ["<alog:0>"],
                "operation": "revert_applied_edit",
                "timeline_duration_sec": 6.0,
                "track_ids": ["host", "guest"],
            },
        }
    ],
    "restore-both": [
        {
            "conflicts": [],
            "status": "restored",
            "summary": {
                "affected_tracks": ["host", "guest"],
                "clip_count": 6,
                "duration_sec": 0.0,
                "ids": ["<alog:0>", "<alog:1>"],
                "operation": "revert_applied_edit",
                "timeline_duration_sec": 6.0,
                "track_ids": ["host", "guest"],
            },
        }
    ],
    "restore-single-record": [
        {
            "conflicts": [],
            "status": "restored",
            "summary": {
                "affected_tracks": ["host"],
                "clip_count": 2,
                "duration_sec": 0.0,
                "ids": ["<alog:0>"],
                "operation": "revert_applied_edit",
                "timeline_duration_sec": 6.0,
                "track_ids": ["host"],
            },
        }
    ],
    "unknown": [
        {
            "conflicts": [
                {
                    "blocked_by": [],
                    "code": "applied_edit_not_found",
                    "message": "Applied edit alog_missing is not in this project.",
                    "record_id": "alog_missing",
                    "track_id": None,
                }
            ],
            "status": "conflict",
            "summary": {},
        }
    ],
    "plan-unknown": [
        {
            "conflicts": [
                {
                    "blocked_by": [],
                    "code": "applied_edit_not_found",
                    "message": "Applied edit alog_missing is not in this project.",
                    "record_id": "alog_missing",
                    "track_id": None,
                }
            ],
            "status": "conflict",
            "summary": {},
        }
    ],
    "known-and-unknown": [
        {
            "conflicts": [
                {
                    "blocked_by": [],
                    "code": "applied_edit_not_found",
                    "message": "Applied edit alog_missing is not in this project.",
                    "record_id": "alog_missing",
                    "track_id": None,
                }
            ],
            "status": "conflict",
            "summary": {},
        }
    ],
    "history-only": [
        {
            "conflicts": [
                {
                    "blocked_by": [],
                    "code": "local_restore_requires_history",
                    "message": "This edit cannot be restored individually. Use History Undo to restore the whole action. History Undo also undoes the other edits in that action. You may need to undo later actions first.",
                    "record_id": "<alog:0>",
                    "track_id": None,
                }
            ],
            "status": "conflict",
            "summary": {},
        }
    ],
    "plan-history-only": [
        {
            "conflicts": [
                {
                    "blocked_by": [],
                    "code": "local_restore_requires_history",
                    "message": "This edit cannot be restored individually. Use History Undo to restore the whole action. History Undo also undoes the other edits in that action. You may need to undo later actions first.",
                    "record_id": "<alog:0>",
                    "track_id": None,
                }
            ],
            "status": "conflict",
            "summary": {},
        }
    ],
    "history-only-with-known": [
        {
            "conflicts": [
                {
                    "blocked_by": [],
                    "code": "local_restore_requires_history",
                    "message": "This edit cannot be restored individually. Use History Undo to restore the whole action. History Undo also undoes the other edits in that action. You may need to undo later actions first.",
                    "record_id": "<alog:0>",
                    "track_id": None,
                }
            ],
            "status": "conflict",
            "summary": {},
        }
    ],
    "restore-twice": [
        {
            "conflicts": [],
            "status": "restored",
            "summary": {
                "affected_tracks": ["host"],
                "clip_count": 4,
                "duration_sec": 0.0,
                "ids": ["<alog:0>"],
                "operation": "revert_applied_edit",
                "timeline_duration_sec": 5.6,
                "track_ids": ["host"],
            },
        },
        {
            "conflicts": [
                {
                    "blocked_by": [],
                    "code": "applied_edit_not_found",
                    "message": "Applied edit <alog:0> is not in this project.",
                    "record_id": "<alog:0>",
                    "track_id": None,
                }
            ],
            "status": "conflict",
            "summary": {},
        },
    ],
    "plan-then-restore": [
        {
            "conflicts": [],
            "status": "planned",
            "summary": {
                "affected_tracks": ["host"],
                "ids": ["<alog:0>"],
                "operation": "revert_applied_edit",
            },
        },
        {
            "conflicts": [],
            "status": "restored",
            "summary": {
                "affected_tracks": ["host"],
                "clip_count": 4,
                "duration_sec": 0.0,
                "ids": ["<alog:0>"],
                "operation": "revert_applied_edit",
                "timeline_duration_sec": 5.6,
                "track_ids": ["host"],
            },
        },
    ],
    "restore-then-other": [
        {
            "conflicts": [],
            "status": "restored",
            "summary": {
                "affected_tracks": ["host"],
                "clip_count": 4,
                "duration_sec": 0.0,
                "ids": ["<alog:0>"],
                "operation": "revert_applied_edit",
                "timeline_duration_sec": 5.6,
                "track_ids": ["host"],
            },
        },
        {
            "conflicts": [],
            "status": "restored",
            "summary": {
                "affected_tracks": ["host", "guest"],
                "clip_count": 6,
                "duration_sec": 0.0,
                "ids": ["<alog:0>"],
                "operation": "revert_applied_edit",
                "timeline_duration_sec": 6.0,
                "track_ids": ["host", "guest"],
            },
        },
    ],
    "nothing-applied": [
        {
            "conflicts": [
                {
                    "blocked_by": [],
                    "code": "applied_edit_not_found",
                    "message": "Applied edit alog_missing is not in this project.",
                    "record_id": "alog_missing",
                    "track_id": None,
                }
            ],
            "status": "conflict",
            "summary": {},
        }
    ],
}


def _ids(picks: str, known: list[str]) -> list[str]:
    return [_MISSING if pick == "?" else known[_PICK[pick]] for pick in picks]


def _payload(ids: list[str], dry_run: bool) -> dict[str, Any]:
    return {"ids": ids, "dry_run": dry_run}


def _service(ws, ids, dry_run, expect_exit):
    return EditService(ws).revert_applied(ids, dry_run)


def _handler(ws, ids, dry_run, expect_exit):
    return edit_handlers.restore_applied_edit(ws, _payload(ids, dry_run))


def _host(ws, ids, dry_run, expect_exit):
    return host_command_result(
        submit_host_document_command(ws.path, "RestoreAppliedEdit", _payload(ids, dry_run))
    )


def _mcp(ws, ids, dry_run, expect_exit):
    return json.loads(edit_tools.revert_applied_edit_tool(str(ws.path), ids, dry_run))


def _cli(ws, ids, dry_run, expect_exit):
    args = ["edit", "restore-edit", "--project", str(ws.path), "--json"]
    for record_id in ids:
        args += ["--id", record_id]
    if dry_run:
        args.append("--dry-run")
    result = CliRunner().invoke(app, args)
    assert result.exit_code == expect_exit, result.output
    return json.loads(result.stdout)


def _web(ws, ids, dry_run, expect_exit):
    with TestClient(create_app()) as client:
        reply = client.post(
            f"/api/document/command?path={quote(str(ws.path))}",
            json={
                "type": "RestoreAppliedEdit",
                "payload": _payload(ids, dry_run),
                "client_id": f"wire-{next(_CLIENTS)}",
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


def _run(tmp_path, name: str, surface: str) -> list[dict[str, Any]]:
    build, steps = _SCENARIOS[name]
    ws = build_workspace(tmp_path, **build)
    known = applied_ids(ws)
    outcomes = []
    for picks, dry_run in steps:
        ids = _ids(picks, known)
        result = _SURFACES[surface](ws, ids, dry_run, 0)
        outcomes.append(normalize(result, ws))
    return outcomes


def _run_cli(tmp_path, name: str) -> list[dict[str, Any]]:
    build, steps = _SCENARIOS[name]
    ws = build_workspace(tmp_path, **build)
    known = applied_ids(ws)
    outcomes = []
    for picks, dry_run in steps:
        ids = _ids(picks, known)
        exit_code = 2 if _EXPECTED[name][len(outcomes)]["status"] == "conflict" else 0
        outcomes.append(normalize(_cli(ws, ids, dry_run, exit_code), ws))
    return outcomes


@pytest.mark.parametrize("surface", [s for s in _SURFACES if s != "cli"])
@pytest.mark.parametrize("name", list(_SCENARIOS))
def test_revert_applied_wire(tmp_path, name, surface):
    assert dump(_run(tmp_path, name, surface)) == dump(_EXPECTED[name])


@pytest.mark.parametrize("name", list(_SCENARIOS))
def test_revert_applied_cli_wire(tmp_path, name):
    assert dump(_run_cli(tmp_path, name)) == dump(_EXPECTED[name])


def test_service_returns_a_plain_dict(tmp_path):
    ws = build_workspace(tmp_path, **_BOTH)
    result = EditService(ws).revert_applied(applied_ids(ws)[:1], dry_run=True)
    assert type(result) is dict
    assert type(result["conflicts"]) is list
    assert type(result["summary"]) is dict


def test_empty_id_list_restores_nothing_on_service_and_handler(tmp_path):
    expected = {
        "conflicts": [],
        "status": "restored",
        "summary": {
            "affected_tracks": [],
            "clip_count": 4,
            "duration_sec": 0.0,
            "ids": [],
            "operation": "revert_applied_edit",
            "timeline_duration_sec": 5.6,
            "track_ids": [],
        },
    }
    for surface in ("service", "handler"):
        ws = build_workspace(tmp_path / surface, **_BOTH)
        result = _SURFACES[surface](ws, [], False, 0)
        assert dump(normalize(result, ws)) == dump(expected)


def test_empty_id_list_dry_run_plans_nothing(tmp_path):
    expected = {
        "conflicts": [],
        "status": "planned",
        "summary": {"affected_tracks": [], "ids": [], "operation": "revert_applied_edit"},
    }
    ws = build_workspace(tmp_path, **_BOTH)
    assert dump(EditService(ws).revert_applied([], dry_run=True)) == dump(expected)
    assert dump(edit_handlers.restore_applied_edit(ws, _payload([], True))) == dump(expected)


def test_empty_id_list_is_refused_before_the_handler_on_command_surfaces(tmp_path):
    ws = build_workspace(tmp_path, **_BOTH)
    before = ws.path.read_bytes()
    with pytest.raises(ValueError, match="ids"):
        submit_host_document_command(ws.path, "RestoreAppliedEdit", _payload([], False))
    with pytest.raises(ValueError, match="ids"):
        edit_tools.revert_applied_edit_tool(str(ws.path), [])
    result = CliRunner().invoke(app, ["edit", "restore-edit", "--project", str(ws.path)])
    assert result.exit_code == 2
    assert ws.path.read_bytes() == before


def test_dry_run_and_conflict_leave_no_journal_row(tmp_path):
    ws = build_workspace(tmp_path, **_BOTH)
    known = applied_ids(ws)
    before = ws.path.read_bytes()
    EditService(ws).revert_applied(known[:1], dry_run=True)
    EditService(ws).revert_applied([_MISSING])
    submit_host_document_command(ws.path, "RestoreAppliedEdit", _payload([_MISSING], False))
    assert ws.path.read_bytes() == before
    assert DocumentSyncService.open(ws.path).store.commands_after(0) == []
