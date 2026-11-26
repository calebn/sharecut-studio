"""Pin the exact wire output of EditService.impact_report, as a dict and as Markdown."""

from __future__ import annotations

import json
from typing import Any

import pytest
from typer.testing import CliRunner

import edit_wire_render as rr
from edit_wire_helpers import build_workspace, normalize
from podcast_mcp.cli.main import app
from podcast_mcp.mcp.tools import edits as edit_tools
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import EditService

pytestmark = pytest.mark.unscoped_ok

_SCENARIOS: dict[str, dict[str, Any]] = {
    "empty": {},
    "pending-only": {"pending": True},
    "mute": {"approve": ("m1",)},
    "cut": {"approve": ("r1",)},
    "mute-and-cut": {"approve": ("m1", "r1")},
    "mute-cut-pending-and-trim": {"approve": ("m1", "r1"), "pending": True, "trim": True},
    "mute-and-pending": {"approve": ("m1",), "pending": True},
    "no-words": {"approve": ("r1",), "words": False},
}

_EXPECTED: dict[str, dict[str, Any]] = {
    "empty": {
        "applied_count": 0,
        "by_track_sec": {},
        "clip_count": 2,
        "gap_count": 0,
        "pending_review_count": 0,
        "segments": [],
        "timeline_duration_sec": 6.0,
        "total_removed_sec": 0.0,
    },
    "pending-only": {
        "applied_count": 0,
        "by_track_sec": {},
        "clip_count": 2,
        "gap_count": 0,
        "pending_review_count": 1,
        "segments": [
            {
                "applied": False,
                "duration_sec": 0.40000000000000036,
                "end": 4.4,
                "id": "p1",
                "reason": "pending",
                "review_required": True,
                "start": 4.0,
                "track_id": "host",
            }
        ],
        "timeline_duration_sec": 6.0,
        "total_removed_sec": 0.0,
    },
    "mute": {
        "applied_count": 1,
        "by_track_sec": {},
        "clip_count": 2,
        "gap_count": 0,
        "pending_review_count": 0,
        "segments": [
            {
                "applied": True,
                "duration_sec": 0.3999999999999999,
                "end": 1.4,
                "id": "<alog:0>",
                "reason": "filler:um",
                "review_required": False,
                "start": 1.0,
                "track_id": "host",
            }
        ],
        "timeline_duration_sec": 6.0,
        "total_removed_sec": 0.0,
    },
    "cut": {
        "applied_count": 1,
        "by_track_sec": {"guest": 0.3999999999999999, "host": 0.3999999999999999},
        "clip_count": 4,
        "gap_count": 0,
        "pending_review_count": 0,
        "segments": [
            {
                "applied": True,
                "duration_sec": 0.3999999999999999,
                "end": 3.4,
                "id": "<alog:0>",
                "reason": "filler:x",
                "review_required": False,
                "start": 3.0,
                "track_id": "host, guest",
            }
        ],
        "timeline_duration_sec": 5.6,
        "total_removed_sec": 0.3999999999999999,
    },
    "mute-and-cut": {
        "applied_count": 2,
        "by_track_sec": {"guest": 0.3999999999999999, "host": 0.3999999999999999},
        "clip_count": 4,
        "gap_count": 0,
        "pending_review_count": 0,
        "segments": [
            {
                "applied": True,
                "duration_sec": 0.3999999999999999,
                "end": 1.4,
                "id": "<alog:0>",
                "reason": "filler:um",
                "review_required": False,
                "start": 1.0,
                "track_id": "host",
            },
            {
                "applied": True,
                "duration_sec": 0.3999999999999999,
                "end": 3.4,
                "id": "<alog:1>",
                "reason": "filler:x",
                "review_required": False,
                "start": 3.0,
                "track_id": "host, guest",
            },
        ],
        "timeline_duration_sec": 5.6,
        "total_removed_sec": 0.3999999999999999,
    },
    "mute-cut-pending-and-trim": {
        "applied_count": 2,
        "by_track_sec": {"guest": 0.3999999999999999, "host": 0.3999999999999999},
        "clip_count": 4,
        "gap_count": 0,
        "pending_review_count": 1,
        "segments": [
            {
                "applied": False,
                "duration_sec": 0.40000000000000036,
                "end": 4.4,
                "id": "p1",
                "reason": "pending",
                "review_required": True,
                "start": 4.0,
                "track_id": "host",
            },
            {
                "applied": True,
                "duration_sec": 0.3999999999999999,
                "end": 1.4,
                "id": "<alog:0>",
                "reason": "filler:um",
                "review_required": False,
                "start": 1.0,
                "track_id": "host",
            },
            {
                "applied": True,
                "duration_sec": 0.3999999999999999,
                "end": 3.4,
                "id": "<alog:1>",
                "reason": "filler:x",
                "review_required": False,
                "start": 3.0,
                "track_id": "host, guest",
            },
        ],
        "timeline_duration_sec": 5.6,
        "total_removed_sec": 0.3999999999999999,
    },
    "mute-and-pending": {
        "applied_count": 1,
        "by_track_sec": {},
        "clip_count": 2,
        "gap_count": 0,
        "pending_review_count": 1,
        "segments": [
            {
                "applied": False,
                "duration_sec": 0.40000000000000036,
                "end": 4.4,
                "id": "p1",
                "reason": "pending",
                "review_required": True,
                "start": 4.0,
                "track_id": "host",
            },
            {
                "applied": True,
                "duration_sec": 0.3999999999999999,
                "end": 1.4,
                "id": "<alog:0>",
                "reason": "filler:um",
                "review_required": False,
                "start": 1.0,
                "track_id": "host",
            },
        ],
        "timeline_duration_sec": 6.0,
        "total_removed_sec": 0.0,
    },
    "no-words": {
        "applied_count": 1,
        "by_track_sec": {"guest": 0.3999999999999999, "host": 0.3999999999999999},
        "clip_count": 4,
        "gap_count": 0,
        "pending_review_count": 0,
        "segments": [
            {
                "applied": True,
                "duration_sec": 0.3999999999999999,
                "end": 3.4,
                "id": "<alog:0>",
                "reason": "filler:x",
                "review_required": False,
                "start": 3.0,
                "track_id": "host, guest",
            }
        ],
        "timeline_duration_sec": 5.6,
        "total_removed_sec": 0.3999999999999999,
    },
}
_EXPECTED_MARKDOWN: dict[str, str] = {
    "empty": "# Edit impact\n- Total removed (applied): **0.0s**\n- Applied edits: 0\n- Pending review: 0\n",
    "pending-only": "# Edit impact\n- Total removed (applied): **0.0s**\n- Applied edits: 0\n- Pending review: 1\n\n\n## Segments\n\n- [pending] host 4.0-4.4s (0.4s) pending",
    "mute": "# Edit impact\n- Total removed (applied): **0.0s**\n- Applied edits: 1\n- Pending review: 0\n\n\n## Segments\n\n- [applied] host 1.0-1.4s (0.4s) filler:um",
    "cut": "# Edit impact\n- Total removed (applied): **0.4s**\n- Applied edits: 1\n- Pending review: 0\n\n- host: 0.4s\n- guest: 0.4s\n\n## Segments\n\n- [applied] host, guest 3.0-3.4s (0.4s) filler:x",
    "mute-and-cut": "# Edit impact\n- Total removed (applied): **0.4s**\n- Applied edits: 2\n- Pending review: 0\n\n- host: 0.4s\n- guest: 0.4s\n\n## Segments\n\n- [applied] host 1.0-1.4s (0.4s) filler:um\n- [applied] host, guest 3.0-3.4s (0.4s) filler:x",
    "mute-cut-pending-and-trim": "# Edit impact\n- Total removed (applied): **0.4s**\n- Applied edits: 2\n- Pending review: 1\n\n- host: 0.4s\n- guest: 0.4s\n\n## Segments\n\n- [pending] host 4.0-4.4s (0.4s) pending\n- [applied] host 1.0-1.4s (0.4s) filler:um\n- [applied] host, guest 3.0-3.4s (0.4s) filler:x",
    "mute-and-pending": "# Edit impact\n- Total removed (applied): **0.0s**\n- Applied edits: 1\n- Pending review: 1\n\n\n## Segments\n\n- [pending] host 4.0-4.4s (0.4s) pending\n- [applied] host 1.0-1.4s (0.4s) filler:um",
    "no-words": "# Edit impact\n- Total removed (applied): **0.4s**\n- Applied edits: 1\n- Pending review: 0\n\n- host: 0.4s\n- guest: 0.4s\n\n## Segments\n\n- [applied] host, guest 3.0-3.4s (0.4s) filler:x",
}


def _service(ws: ProjectWorkspace, markdown: bool) -> Any:
    return EditService(ws).impact_report(markdown=markdown)


def _mcp(ws: ProjectWorkspace, markdown: bool) -> Any:
    text = edit_tools.edit_impact_report_tool(str(ws.path), markdown=markdown)
    return text if markdown else json.loads(text)


def _cli(ws: ProjectWorkspace, markdown: bool) -> Any:
    result = CliRunner().invoke(app, ["edit", "impact", "--project", str(ws.path)])
    assert result.exit_code == 0, result.output
    assert result.output.endswith("\n")
    return result.output[:-1]


def _web(ws: ProjectWorkspace, markdown: bool) -> Any:
    return rr.web_view(ws)["edit_impact"]


@pytest.mark.parametrize("surface", ["service", "mcp", "web"])
@pytest.mark.parametrize("name", list(_SCENARIOS))
def test_impact_report_dict_wire(tmp_path, name, surface):
    ws = build_workspace(tmp_path, **_SCENARIOS[name])
    result = {"service": _service, "mcp": _mcp, "web": _web}[surface](ws, False)
    assert type(result) is dict
    assert normalize(result, ws) == _EXPECTED[name]


@pytest.mark.parametrize("surface", ["service", "mcp", "cli"])
@pytest.mark.parametrize("name", list(_SCENARIOS))
def test_impact_report_markdown_wire(tmp_path, name, surface):
    ws = build_workspace(tmp_path, **_SCENARIOS[name])
    result = {"service": _service, "mcp": _mcp, "cli": _cli}[surface](ws, True)
    assert type(result) is str
    assert result == _EXPECTED_MARKDOWN[name]


def test_markdown_flag_defaults_to_the_dict(tmp_path):
    ws = build_workspace(tmp_path, approve=("m1",))
    assert EditService(ws).impact_report() == EditService(ws).impact_report(markdown=False)
    assert type(EditService(ws).impact_report()) is dict
    assert type(EditService(ws).impact_report(markdown=True)) is str


def test_dict_keys_are_the_eight_report_fields(tmp_path):
    report = EditService(build_workspace(tmp_path)).impact_report()
    assert sorted(report) == [
        "applied_count",
        "by_track_sec",
        "clip_count",
        "gap_count",
        "pending_review_count",
        "segments",
        "timeline_duration_sec",
        "total_removed_sec",
    ]
