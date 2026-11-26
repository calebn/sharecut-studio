"""Pin the exact wire output of EditService.list_applied_edits on every surface."""

from __future__ import annotations

import json
from typing import Any

import pytest
from typer.testing import CliRunner

from edit_wire_helpers import build_workspace, normalize
from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools import timeline
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService

pytestmark = pytest.mark.unscoped_ok

_MUTE = {"approve": ("m1",)}
_CUT = {"approve": ("r1",)}
_BOTH = {"approve": ("m1", "r1")}
_ALL = {"approve": ("m1", "r1"), "trim": True, "pending": True}
_FLAGS = {"track_id": "--track", "timeline_start": "--start", "timeline_end": "--end"}

_SCENARIOS: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {
    "empty": ({}, {}),
    "pending-only": ({"pending": True}, {}),
    "mute": (_MUTE, {}),
    "cut": (_CUT, {}),
    "both": (_BOTH, {}),
    "both-trim-and-pending": (_ALL, {}),
    "track-host": (_BOTH, {"track_id": "host"}),
    "track-guest": (_BOTH, {"track_id": "guest"}),
    "track-unknown": (_BOTH, {"track_id": "nobody"}),
    "start-only": (_BOTH, {"timeline_start": 2.0}),
    "end-only": (_BOTH, {"timeline_end": 2.0}),
    "window-around-mute": (_BOTH, {"timeline_start": 0.5, "timeline_end": 1.5}),
    "window-around-cut": (_BOTH, {"timeline_start": 2.5, "timeline_end": 3.5}),
    "window-with-no-edits": (_BOTH, {"timeline_start": 4.5, "timeline_end": 5.5}),
    "window-and-track": (_BOTH, {"track_id": "guest", "timeline_start": 0.0, "timeline_end": 2.0}),
    "window-and-track-trim": (
        _ALL,
        {"track_id": "host", "timeline_start": 0.0, "timeline_end": 2.0},
    ),
}

_EXPECTED: dict[str, dict[str, Any]] = {
    "empty": {"count": 0, "records": []},
    "pending-only": {"count": 0, "records": []},
    "mute": {
        "count": 1,
        "records": [
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["m1"],
                "id": "<alog:0>",
                "operation": "approve_edits",
                "params": {
                    "mute": True,
                    "per_track_source": {"host": [0.995, 1.4149999999999998]},
                    "scope": "session",
                },
                "reason": "filler:um",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 1.4,
                "source_start": 1.0,
                "timeline_end": 1.4,
                "timeline_start": 1.0,
                "track_ids": ["host"],
            }
        ],
    },
    "cut": {
        "count": 1,
        "records": [
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["r1"],
                "id": "<alog:0>",
                "operation": "approve_edits",
                "params": {
                    "crossfade_ms": 10,
                    "next_burst_sec": None,
                    "pad_samples": [],
                    "per_track_source": {"guest": [3.0, 3.4], "host": [3.0, 3.4]},
                    "replace_gap_sec": None,
                    "scope": "session",
                    "source_end": 3.4,
                    "source_start": 3.0,
                    "use_inaudible_opt": False,
                },
                "reason": "filler:x",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 3.4,
                "source_start": 3.0,
                "timeline_end": 3.4,
                "timeline_start": 3.0,
                "track_ids": ["host", "guest"],
            }
        ],
    },
    "both": {
        "count": 2,
        "records": [
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["m1"],
                "id": "<alog:0>",
                "operation": "approve_edits",
                "params": {
                    "mute": True,
                    "per_track_source": {"host": [0.995, 1.4149999999999998]},
                    "scope": "session",
                },
                "reason": "filler:um",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 1.4,
                "source_start": 1.0,
                "timeline_end": 1.4,
                "timeline_start": 1.0,
                "track_ids": ["host"],
            },
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["r1"],
                "id": "<alog:1>",
                "operation": "approve_edits",
                "params": {
                    "crossfade_ms": 10,
                    "next_burst_sec": None,
                    "pad_samples": [],
                    "per_track_source": {"guest": [3.0, 3.4], "host": [3.0, 3.4]},
                    "replace_gap_sec": None,
                    "scope": "session",
                    "source_end": 3.4,
                    "source_start": 3.0,
                    "use_inaudible_opt": False,
                },
                "reason": "filler:x",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 3.4,
                "source_start": 3.0,
                "timeline_end": 3.4,
                "timeline_start": 3.0,
                "track_ids": ["host", "guest"],
            },
        ],
    },
    "both-trim-and-pending": {
        "count": 3,
        "records": [
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["m1"],
                "id": "<alog:0>",
                "operation": "approve_edits",
                "params": {
                    "mute": True,
                    "per_track_source": {"host": [0.995, 1.4149999999999998]},
                    "scope": "session",
                },
                "reason": "filler:um",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 1.4,
                "source_start": 1.0,
                "timeline_end": 1.4,
                "timeline_start": 1.0,
                "track_ids": ["host"],
            },
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["r1"],
                "id": "<alog:1>",
                "operation": "approve_edits",
                "params": {
                    "crossfade_ms": 10,
                    "next_burst_sec": None,
                    "pad_samples": [],
                    "per_track_source": {"guest": [3.0, 3.4], "host": [3.0, 3.4]},
                    "replace_gap_sec": None,
                    "scope": "session",
                    "source_end": 3.4,
                    "source_start": 3.0,
                    "use_inaudible_opt": False,
                },
                "reason": "filler:x",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 3.4,
                "source_start": 3.0,
                "timeline_end": 3.4,
                "timeline_start": 3.0,
                "track_ids": ["host", "guest"],
            },
            {
                "applied_at": "<ts>",
                "boundary_mode": None,
                "crossfade_ms": None,
                "cut_confidence": None,
                "decision_ids": [],
                "id": "<alog:2>",
                "operation": "trim_clip_edge",
                "params": {},
                "reason": None,
                "restore": {
                    "blocked_by": [],
                    "code": "local_restore_requires_history",
                    "message": "This edit cannot be restored individually. Use History Undo to restore the whole action. History Undo also undoes the other edits in that action. You may need to undo later actions first.",
                    "state": "history_only",
                },
                "source_end": None,
                "source_start": None,
                "timeline_end": None,
                "timeline_start": None,
                "track_ids": ["host"],
            },
        ],
    },
    "track-host": {
        "count": 2,
        "records": [
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["m1"],
                "id": "<alog:0>",
                "operation": "approve_edits",
                "params": {
                    "mute": True,
                    "per_track_source": {"host": [0.995, 1.4149999999999998]},
                    "scope": "session",
                },
                "reason": "filler:um",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 1.4,
                "source_start": 1.0,
                "timeline_end": 1.4,
                "timeline_start": 1.0,
                "track_ids": ["host"],
            },
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["r1"],
                "id": "<alog:1>",
                "operation": "approve_edits",
                "params": {
                    "crossfade_ms": 10,
                    "next_burst_sec": None,
                    "pad_samples": [],
                    "per_track_source": {"guest": [3.0, 3.4], "host": [3.0, 3.4]},
                    "replace_gap_sec": None,
                    "scope": "session",
                    "source_end": 3.4,
                    "source_start": 3.0,
                    "use_inaudible_opt": False,
                },
                "reason": "filler:x",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 3.4,
                "source_start": 3.0,
                "timeline_end": 3.4,
                "timeline_start": 3.0,
                "track_ids": ["host", "guest"],
            },
        ],
    },
    "track-guest": {
        "count": 1,
        "records": [
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["r1"],
                "id": "<alog:0>",
                "operation": "approve_edits",
                "params": {
                    "crossfade_ms": 10,
                    "next_burst_sec": None,
                    "pad_samples": [],
                    "per_track_source": {"guest": [3.0, 3.4], "host": [3.0, 3.4]},
                    "replace_gap_sec": None,
                    "scope": "session",
                    "source_end": 3.4,
                    "source_start": 3.0,
                    "use_inaudible_opt": False,
                },
                "reason": "filler:x",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 3.4,
                "source_start": 3.0,
                "timeline_end": 3.4,
                "timeline_start": 3.0,
                "track_ids": ["host", "guest"],
            }
        ],
    },
    "track-unknown": {"count": 0, "records": []},
    "start-only": {
        "count": 2,
        "records": [
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["m1"],
                "id": "<alog:0>",
                "operation": "approve_edits",
                "params": {
                    "mute": True,
                    "per_track_source": {"host": [0.995, 1.4149999999999998]},
                    "scope": "session",
                },
                "reason": "filler:um",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 1.4,
                "source_start": 1.0,
                "timeline_end": 1.4,
                "timeline_start": 1.0,
                "track_ids": ["host"],
            },
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["r1"],
                "id": "<alog:1>",
                "operation": "approve_edits",
                "params": {
                    "crossfade_ms": 10,
                    "next_burst_sec": None,
                    "pad_samples": [],
                    "per_track_source": {"guest": [3.0, 3.4], "host": [3.0, 3.4]},
                    "replace_gap_sec": None,
                    "scope": "session",
                    "source_end": 3.4,
                    "source_start": 3.0,
                    "use_inaudible_opt": False,
                },
                "reason": "filler:x",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 3.4,
                "source_start": 3.0,
                "timeline_end": 3.4,
                "timeline_start": 3.0,
                "track_ids": ["host", "guest"],
            },
        ],
    },
    "end-only": {
        "count": 2,
        "records": [
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["m1"],
                "id": "<alog:0>",
                "operation": "approve_edits",
                "params": {
                    "mute": True,
                    "per_track_source": {"host": [0.995, 1.4149999999999998]},
                    "scope": "session",
                },
                "reason": "filler:um",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 1.4,
                "source_start": 1.0,
                "timeline_end": 1.4,
                "timeline_start": 1.0,
                "track_ids": ["host"],
            },
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["r1"],
                "id": "<alog:1>",
                "operation": "approve_edits",
                "params": {
                    "crossfade_ms": 10,
                    "next_burst_sec": None,
                    "pad_samples": [],
                    "per_track_source": {"guest": [3.0, 3.4], "host": [3.0, 3.4]},
                    "replace_gap_sec": None,
                    "scope": "session",
                    "source_end": 3.4,
                    "source_start": 3.0,
                    "use_inaudible_opt": False,
                },
                "reason": "filler:x",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 3.4,
                "source_start": 3.0,
                "timeline_end": 3.4,
                "timeline_start": 3.0,
                "track_ids": ["host", "guest"],
            },
        ],
    },
    "window-around-mute": {
        "count": 1,
        "records": [
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["m1"],
                "id": "<alog:0>",
                "operation": "approve_edits",
                "params": {
                    "mute": True,
                    "per_track_source": {"host": [0.995, 1.4149999999999998]},
                    "scope": "session",
                },
                "reason": "filler:um",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 1.4,
                "source_start": 1.0,
                "timeline_end": 1.4,
                "timeline_start": 1.0,
                "track_ids": ["host"],
            }
        ],
    },
    "window-around-cut": {
        "count": 1,
        "records": [
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["r1"],
                "id": "<alog:0>",
                "operation": "approve_edits",
                "params": {
                    "crossfade_ms": 10,
                    "next_burst_sec": None,
                    "pad_samples": [],
                    "per_track_source": {"guest": [3.0, 3.4], "host": [3.0, 3.4]},
                    "replace_gap_sec": None,
                    "scope": "session",
                    "source_end": 3.4,
                    "source_start": 3.0,
                    "use_inaudible_opt": False,
                },
                "reason": "filler:x",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 3.4,
                "source_start": 3.0,
                "timeline_end": 3.4,
                "timeline_start": 3.0,
                "track_ids": ["host", "guest"],
            }
        ],
    },
    "window-with-no-edits": {"count": 0, "records": []},
    "window-and-track": {"count": 0, "records": []},
    "window-and-track-trim": {
        "count": 1,
        "records": [
            {
                "applied_at": "<ts>",
                "boundary_mode": "vocal_transcript_guided",
                "crossfade_ms": 10,
                "cut_confidence": None,
                "decision_ids": ["m1"],
                "id": "<alog:0>",
                "operation": "approve_edits",
                "params": {
                    "mute": True,
                    "per_track_source": {"host": [0.995, 1.4149999999999998]},
                    "scope": "session",
                },
                "reason": "filler:um",
                "restore": {"blocked_by": [], "code": None, "message": None, "state": "ready"},
                "source_end": 1.4,
                "source_start": 1.0,
                "timeline_end": 1.4,
                "timeline_start": 1.0,
                "track_ids": ["host"],
            }
        ],
    },
}


def _service(ws: ProjectWorkspace, kwargs: dict[str, Any]) -> Any:
    return EditService(ws).list_applied_edits(**kwargs)


def _mcp(ws: ProjectWorkspace, kwargs: dict[str, Any]) -> Any:
    return json.loads(timeline.list_applied_edits_tool(str(ws.path), **kwargs))


def _cli(ws: ProjectWorkspace, kwargs: dict[str, Any]) -> Any:
    flags = [part for key, value in kwargs.items() for part in (_FLAGS[key], str(value))]
    result = CliRunner().invoke(app, ["edit", "list-applied", "--project", str(ws.path), *flags])
    assert result.exit_code == 0, result.output
    return json.loads(result.output)


_SURFACES = {"service": _service, "mcp": _mcp, "cli": _cli}


@pytest.mark.parametrize("surface", list(_SURFACES))
@pytest.mark.parametrize("name", list(_SCENARIOS))
def test_list_applied_edits_wire(tmp_path, name, surface):
    build, kwargs = _SCENARIOS[name]
    ws = build_workspace(tmp_path, **build)
    assert normalize(_SURFACES[surface](ws, kwargs), ws) == _EXPECTED[name]


@pytest.mark.parametrize(
    "name", [n for n, (_, kw) in _SCENARIOS.items() if set(kw) <= {"track_id"}]
)
def test_applied_json_command_matches(tmp_path, name):
    build, kwargs = _SCENARIOS[name]
    ws = build_workspace(tmp_path, **build)
    flags = ["--track", kwargs["track_id"]] if kwargs else []
    result = CliRunner().invoke(
        app, ["edit", "applied", "--project", str(ws.path), "--json", *flags]
    )
    assert result.exit_code == 0, result.output
    assert normalize(json.loads(result.output), ws) == _EXPECTED[name]


def test_applied_text_command_prints_id_operation_and_restore_state(tmp_path):
    ws = build_workspace(tmp_path, **_ALL)
    result = CliRunner().invoke(app, ["edit", "applied", "--project", str(ws.path)])
    assert result.exit_code == 0, result.output
    records = EditService(ws).list_applied_edits()["records"]
    assert result.output.splitlines() == [
        f"{records[0]['id']}\tapprove_edits\tready",
        f"{records[1]['id']}\tapprove_edits\tready",
        f"{records[2]['id']}\ttrim_clip_edge\thistory_only",
    ]


def test_service_returns_a_plain_dict_of_plain_records(tmp_path):
    ws = build_workspace(tmp_path, **_BOTH)
    listing = EditService(ws).list_applied_edits()
    assert type(listing) is dict
    assert sorted(listing) == ["count", "records"]
    assert all(type(record) is dict for record in listing["records"])
    assert all(type(record["restore"]) is dict for record in listing["records"])
    assert all("inverse" not in record for record in listing["records"])
