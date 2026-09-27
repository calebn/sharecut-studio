"""Effective join render fields and the shared neighbour rule."""

from __future__ import annotations

import pytest

from podcast_mcp.edits.clips_ops import (
    clip_index,
    crossfade_block_reason,
    crossfade_ms_at_join,
    join_render_fields,
    neighbour_clips,
    previous_clip,
    uses_crossfade_join,
)
from podcast_mcp.models import Clip, ClipJoinMode, EpisodeProject, Track, TrackRole


def _clip(cid: str, start: float, end: float, *, track: str = "host", **kw) -> Clip:
    return Clip(
        id=cid,
        track_id=track,
        source_start=start,
        source_end=end,
        timeline_start=start,
        **kw,
    )


def _project(*clips: Clip) -> EpisodeProject:
    p = EpisodeProject.create("join_test", "/tmp/join_test")
    p.tracks = [
        Track(id="host", label="Host", role=TrackRole.DIALOGUE),
        Track(id="guest", label="Guest", role=TrackRole.DIALOGUE),
    ]
    p.clips = list(clips)
    return p


def test_block_reasons():
    a = _clip("a", 0, 1, fade_out_ms=20)
    assert crossfade_block_reason(a, _clip("b", 1, 2, fade_in_ms=20)) is None
    assert crossfade_block_reason(a, _clip("b", 1.5, 2.5, fade_in_ms=20)) == "not_abutting"
    assert crossfade_block_reason(_clip("a", 0, 1), _clip("b", 1, 2, fade_in_ms=20)) == (
        "no_fade_out"
    )
    assert crossfade_block_reason(a, _clip("b", 1, 2)) == "no_fade_in"


def test_join_render_fields_modes():
    left = _clip("a", 0, 1, fade_out_ms=20)
    cross = _clip("b", 1, 2, fade_in_ms=30, join_in_mode=ClipJoinMode.CROSSFADE)
    assert uses_crossfade_join(left, cross)
    assert crossfade_ms_at_join(left, cross) == 20
    assert join_render_fields(left, cross) == {
        "join_left_clip_id": "a",
        "join_render_mode": "crossfade",
        "join_crossfade_ms": 20,
        "join_crossfade_blocked": None,
    }
    blocked = _clip("c", 1, 2, join_in_mode=ClipJoinMode.CROSSFADE)
    fields = join_render_fields(left, blocked)
    assert fields["join_render_mode"] == "crossfade"
    assert fields["join_crossfade_ms"] == 0
    assert fields["join_crossfade_blocked"] == "no_fade_in"
    assert join_render_fields(None, cross)["join_left_clip_id"] is None
    cut = _clip("d", 1, 2, join_in_mode=ClipJoinMode.CUT)
    assert join_render_fields(left, cut)["join_render_mode"] == "cut"


def test_neighbour_clips_errors():
    p = _project(
        _clip("a", 0, 1),
        _clip("b", 1, 2),
        _clip("c", 2, 3),
        _clip("g", 0, 1, track="guest"),
    )
    left, right, track_clips, idx = neighbour_clips(p, "a", "b")
    assert (left.id, right.id, idx, len(track_clips)) == ("a", "b", 0, 3)
    with pytest.raises(ValueError, match="unknown left_clip_id"):
        neighbour_clips(p, "x", "b")
    with pytest.raises(ValueError, match="unknown right_clip_id"):
        neighbour_clips(p, "a", "x")
    with pytest.raises(ValueError, match="same track"):
        neighbour_clips(p, "a", "g")
    with pytest.raises(ValueError, match="next clip"):
        neighbour_clips(p, "a", "c")
    with pytest.raises(ValueError, match="next clip"):
        neighbour_clips(p, "c", "a")


def test_clip_index_raises_value_error_for_missing_clip():
    clips = [_clip("a", 0, 1), _clip("b", 1, 2)]
    assert clip_index(clips, "b") == 1
    with pytest.raises(ValueError, match="unknown clip_id"):
        clip_index(clips, "zz")


def test_previous_clip_returns_neighbour_or_none():
    clips = [_clip("a", 0, 1), _clip("b", 1, 2)]
    assert previous_clip(clips, "a") is None
    assert previous_clip(clips, "b") is clips[0]
    with pytest.raises(ValueError, match="unknown clip_id"):
        previous_clip(clips, "zz")
