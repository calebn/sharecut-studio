from __future__ import annotations

import json

import pytest

from pause_policy_public_helpers import configure, defaults
from podcast_mcp.mcp.tools import timeline as mcp_timeline
from podcast_mcp.util.coded_error import CodedValueError
from test_fill_room_tone_wire_fixtures import BED_PAD, WIRE_KEYS, gappy_path, single_clip_path

pytestmark = pytest.mark.unscoped_ok


@pytest.fixture(autouse=True)
def _config(monkeypatch):
    configure(monkeypatch, defaults())


def test_the_tool_text_is_the_wire_json_in_key_order(tmp_path):
    text = mcp_timeline.fill_with_room_tone_tool(gappy_path(tmp_path, "ws"), track_id="host")
    reply = json.loads(text)
    assert list(reply) == WIRE_KEYS
    assert reply["pad_samples"] == [BED_PAD] * 4
    assert json.dumps(reply, sort_keys=True) == (
        '{"affected_tracks": ["host"], "clip_count": 6, "operation": "fill_with_room_tone", '
        '"pad_samples": ['
        + ", ".join(
            [
                '{"source_end": 0.25, "source_id": "room-tone-host", "source_start": 0.0, '
                '"track_id": "host"}'
            ]
            * 4
        )
        + '], "timeline_duration_sec": 6.0}'
    )


def test_the_tool_text_for_an_unchanged_track_carries_the_unchanged_flag(tmp_path):
    text = mcp_timeline.fill_with_room_tone_tool(single_clip_path(tmp_path), track_id="host")
    assert json.loads(text)["unchanged"] is True
    assert json.dumps(json.loads(text), sort_keys=True) == (
        '{"affected_tracks": ["host"], "clip_count": 1, "operation": "fill_with_room_tone", '
        '"pad_samples": [], "timeline_duration_sec": 6.0, "unchanged": true}'
    )


@pytest.mark.parametrize(
    ("kwargs", "code", "message"),
    [
        (
            {"track_id": "host", "start_sec": 0.5},
            "range_incomplete",
            "a range fill needs track_id, start_sec and end_sec",
        ),
        (
            {"track_id": "host", "end_sec": 1.5},
            "range_incomplete",
            "a range fill needs track_id, start_sec and end_sec",
        ),
        (
            {"start_sec": 0.5, "end_sec": 1.5},
            "range_incomplete",
            "a range fill needs track_id, start_sec and end_sec",
        ),
        ({}, "missing_argument", "track_id or speaker is required"),
    ],
)
def test_argument_errors_are_raised_before_any_command(tmp_path, kwargs, code, message):
    path = gappy_path(tmp_path, "ws")
    with pytest.raises(CodedValueError) as raised:
        mcp_timeline.fill_with_room_tone_tool(path, **kwargs)
    assert (raised.value.code, str(raised.value)) == (code, message)
