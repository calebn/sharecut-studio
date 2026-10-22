"""Effective join render fields and the shared neighbour rule."""

from __future__ import annotations

import pytest

from podcast_mcp.engines.clips_ops import (
    clip_index,
    crossfade_block_reason,
    crossfade_borrow_sec,
    crossfade_ms_at_join,
    join_render_fields,
    neighbour_clips,
    previous_clip,
    uses_crossfade_join,
)
from podcast_mcp.models import Clip, ClipJoinMode, EpisodeProject, MediaAsset, Track, TrackRole


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
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="h.wav", duration_sec=10),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="g.wav", duration_sec=10),
        ),
    ]
    p.clips = list(clips)
    return p


def test_block_reasons():
    p = _project()
    x = ClipJoinMode.CROSSFADE
    a = _clip("a", 0, 1, fade_out_ms=20)
    assert crossfade_block_reason(a, _clip("b", 1, 2, fade_in_ms=20, join_in_mode=x), p) is None
    assert (
        crossfade_block_reason(a, _clip("b", 1.5, 2.5, fade_in_ms=20, join_in_mode=x), p)
        == "not_abutting"
    )
    assert (
        crossfade_block_reason(_clip("a", 0, 1), _clip("b", 1, 2, fade_in_ms=20, join_in_mode=x), p)
        == "no_fade_out"
    )
    assert crossfade_block_reason(a, _clip("b", 1, 2, join_in_mode=x), p) == "no_fade_in"
    # The left recording ends at the seam: nothing to borrow.
    end = _clip("e", 9, 10, fade_out_ms=20)
    assert (
        crossfade_block_reason(end, _clip("f", 10, 11, fade_in_ms=20, join_in_mode=x), p)
        == "no_headroom"
    )
    # A clip naming a missing recording has no room either (and does not raise).
    ghost = _clip("g", 0, 1, fade_out_ms=20, source_id="gone")
    assert (
        crossfade_block_reason(ghost, _clip("h", 1, 2, fade_in_ms=20, join_in_mode=x), p)
        == "no_headroom"
    )


def test_join_render_fields_modes():
    left = _clip("a", 0, 1, fade_out_ms=20)
    cross = _clip("b", 1, 2, fade_in_ms=30, join_in_mode=ClipJoinMode.CROSSFADE)
    assert uses_crossfade_join(left, cross)
    assert crossfade_ms_at_join(left, cross) == 20
    assert join_render_fields(left, cross, _project()) == {
        "join_left_clip_id": "a",
        "join_render_mode": "crossfade",
        "join_crossfade_ms": 20,
        "join_crossfade_blocked": None,
        "join_borrow_sec": 0.01,
    }
    blocked = _clip("c", 1, 2, join_in_mode=ClipJoinMode.CROSSFADE)
    fields = join_render_fields(left, blocked, _project())
    assert fields["join_render_mode"] == "crossfade"
    assert fields["join_crossfade_ms"] == 0
    assert fields["join_crossfade_blocked"] == "no_fade_in"
    assert join_render_fields(None, cross, _project())["join_left_clip_id"] is None
    cut = _clip("d", 1, 2, join_in_mode=ClipJoinMode.CUT)
    assert join_render_fields(left, cut, _project())["join_render_mode"] == "cut"


@pytest.mark.parametrize(
    ("fade_out_ms", "fade_in_ms", "expected"),
    [(10, 60, 30), (60, 10, 30), (40, 50, 40), (20, 20, 20)],
)
def test_crossfade_ms_at_join_unequal_fades(fade_out_ms: int, fade_in_ms: int, expected: int):
    left = _clip("a", 0, 1, fade_out_ms=fade_out_ms)
    right = _clip("b", 1, 2, fade_in_ms=fade_in_ms, join_in_mode=ClipJoinMode.CROSSFADE)
    assert crossfade_ms_at_join(left, right) == expected
    assert join_render_fields(left, right, _project())["join_crossfade_ms"] == expected


def test_crossfade_ms_at_join_is_zero_when_not_a_crossfade():
    left = _clip("a", 0, 1, fade_out_ms=10)
    assert crossfade_ms_at_join(left, _clip("b", 1, 2, fade_in_ms=60)) == 0


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


@pytest.mark.parametrize(
    ("fade_ms", "expected"),
    [(25, 0.01), (30, 0.015), (22, 0.010), (200, 0.1)],
)
def test_borrow_is_whole_five_ms_steps(fade_ms: int, expected: float):
    left = _clip("a", 0, 1, fade_out_ms=fade_ms)
    right = _clip("b", 1, 2, fade_in_ms=fade_ms, join_in_mode=ClipJoinMode.CROSSFADE)
    got = crossfade_borrow_sec(_project(), left, right)
    assert got == pytest.approx(expected)


def test_a_sliver_of_room_plays_the_fades_not_a_click_blend():
    p = _project()
    left = _clip("a", 8.99, 9.99, fade_out_ms=40)
    right = _clip("b", 9.99, 10.0, fade_in_ms=40, join_in_mode=ClipJoinMode.CROSSFADE)
    p.clips = [left, right]
    # 10 ms of room on the right recording's side (a quarter of 10 ms) is under a blend.
    assert crossfade_borrow_sec(p, left, right) == 0.0
    assert join_render_fields(left, right, p)["join_crossfade_blocked"] == "no_headroom"
