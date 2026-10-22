from __future__ import annotations

import pytest

from pause_policy_public_helpers import add_bed, configure, defaults, project
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.timeline_ops import fill_with_room_tone
from podcast_mcp.models import Clip
from podcast_mcp.services.document_sync.capabilities import (
    EDIT_COMMANDS,
    SUGGEST_COMMANDS,
)
from podcast_mcp.util.coded_error import CodedValueError


def _two_clips_with_gap(result):
    result.clips = [
        Clip(id="left", track_id="host", source_start=0, source_end=1, timeline_start=0),
        Clip(id="right", track_id="host", source_start=2, source_end=6, timeline_start=2.0),
    ]


def test_range_fill_fills_only_clip_free_time_inside_the_range(tmp_path, monkeypatch):
    configure(monkeypatch, defaults())
    result = project(tmp_path)
    add_bed(result, tmp_path)
    _two_clips_with_gap(result)

    fill_with_room_tone(result, "host", within=(0.5, 1.5), defaults=load_defaults())

    pads = sorted(
        (c for c in result.clips if c.id not in {"left", "right"}), key=lambda c: c.timeline_start
    )
    assert pads[0].timeline_start == pytest.approx(1.0)
    assert pads[-1].timeline_end == pytest.approx(1.5)
    left = next(c for c in result.clips if c.id == "left")
    right = next(c for c in result.clips if c.id == "right")
    assert (left.timeline_start, left.timeline_end) == pytest.approx((0, 1))
    assert (right.timeline_start, right.timeline_end) == pytest.approx((2, 6))


def test_range_fill_over_a_clip_only_range_has_nothing_to_fill(tmp_path, monkeypatch):
    configure(monkeypatch, defaults())
    result = project(tmp_path)
    _two_clips_with_gap(result)

    with pytest.raises(CodedValueError) as raised:
        fill_with_room_tone(result, "host", within=(0.1, 0.9), defaults=load_defaults())

    assert raised.value.code == "nothing_to_fill"


def test_range_fill_without_a_source_says_no_source(tmp_path, monkeypatch):
    configure(monkeypatch, defaults())
    result = project(tmp_path, guest="digital")
    result.clips = [
        Clip(id="left", track_id="guest", source_start=0, source_end=1, timeline_start=0),
        Clip(id="right", track_id="guest", source_start=2, source_end=6, timeline_start=2.0),
    ]

    with pytest.raises(CodedValueError) as raised:
        fill_with_room_tone(result, "guest", within=(1.0, 2.0), defaults=load_defaults())

    assert raised.value.code == "no_source"


def test_fill_room_tone_is_an_editor_command_only():
    assert "FillRoomTone" in EDIT_COMMANDS
    assert "FillRoomTone" not in SUGGEST_COMMANDS
