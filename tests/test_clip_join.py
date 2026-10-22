"""Effective join render fields and the shared neighbour rule."""

from __future__ import annotations

import random
from itertools import pairwise

import pytest

from podcast_mcp.engines.clips_ops import (
    MuteIndex,
    clip_index,
    crossfade_block_reason,
    crossfade_borrow_sec,
    crossfade_ms_at_join,
    is_splice,
    join_render_fields,
    neighbour_clips,
    previous_clip,
    uses_crossfade_join,
)
from podcast_mcp.models import (
    Clip,
    ClipJoinMode,
    ClipMuteRegion,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
)


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
    end = _clip("e", 9, 10, fade_out_ms=20)
    assert (
        crossfade_block_reason(end, _clip("f", 10, 11, fade_in_ms=20, join_in_mode=x), p)
        == "no_headroom"
    )
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
    assert crossfade_borrow_sec(p, left, right) == 0.0
    assert join_render_fields(left, right, p)["join_crossfade_blocked"] == "no_headroom"


def test_a_request_under_one_step_still_blends_for_one_step():
    left = _clip("a", 0, 1, fade_out_ms=4)
    right = _clip("b", 1, 2, fade_in_ms=4, join_in_mode=ClipJoinMode.CROSSFADE)
    assert crossfade_borrow_sec(_project(), left, right) == pytest.approx(0.005)


@pytest.mark.parametrize(
    ("owner", "span"),
    [("a", (1.9, 2.0)), ("b", (2.0, 2.1)), ("b", (2.004, 2.2)), ("a", (1.5, 1.996))],
)
def test_a_join_never_borrows_muted_audio_of_its_neighbour(owner, span):
    p = _project()
    left = _clip("a", 1, 2, fade_out_ms=40)
    right = _clip("b", 2, 3, fade_in_ms=40, join_in_mode=ClipJoinMode.CROSSFADE)
    p.clips = [left, right]
    {"a": left, "b": right}[owner].mute_regions = [ClipMuteRegion(start_s=span[0], end_s=span[1])]
    h = crossfade_borrow_sec(p, left, right)
    assert (
        h == 0.0 or (owner == "b" and span[0] - 2.0 >= h) or (owner == "a" and 2.0 - span[1] >= h)
    )


def test_a_mute_on_an_aliased_recording_stops_the_borrow():
    from podcast_mcp.models.episode import SourceRecording

    p = _project()
    p.tracks[0].media = MediaAsset(path="h.wav", duration_sec=10)
    p.sources = [SourceRecording(id="s1", path="h.wav", duration_sec=10)]
    left = _clip("a", 1, 2, fade_out_ms=40)
    right = _clip("b", 2, 3, fade_in_ms=40, join_in_mode=ClipJoinMode.CROSSFADE)
    other = _clip("c", 5, 6, source_id="s1")
    other.mute_regions = [ClipMuteRegion(start_s=2.0, end_s=2.5)]
    p.clips = [left, right, other]
    assert crossfade_borrow_sec(p, left, right) == 0.0


def test_the_mute_index_keeps_a_long_crossfade_lane_fast():
    import time

    p = _project()
    clips = []
    for i in range(3000):
        c = _clip(f"c{i}", i * 3, i * 3 + 3, fade_in_ms=40, fade_out_ms=40)
        c.timeline_start = i * 3
        c.join_in_mode = ClipJoinMode.CROSSFADE
        c.mute_regions = [ClipMuteRegion(start_s=i * 3 + 1, end_s=i * 3 + 1.2)]
        clips.append(c)
    p.tracks[0].media = MediaAsset(path="h.wav", duration_sec=10_000)
    p.clips = clips
    from podcast_mcp.engines.clips_ops import MuteIndex

    started = time.perf_counter()
    index = MuteIndex(p)
    for prev, c in pairwise(clips):
        assert crossfade_borrow_sec(p, prev, c, index) > 0
    assert time.perf_counter() - started < 2.0


def test_a_mute_equal_to_an_ignored_word_span_does_not_break_the_index():
    from podcast_mcp.models import Transcript, TranscriptWord

    p = _project()
    left = _clip("a", 1, 2, fade_out_ms=40)
    right = _clip("b", 2, 3, fade_in_ms=40, join_in_mode=ClipJoinMode.CROSSFADE)
    right.mute_regions = [ClipMuteRegion(start_s=2.2, end_s=2.4)]
    p.clips = [left, right]
    p.transcripts = [
        Transcript(
            track_id="host",
            words=[TranscriptWord(text="x", start=2.2, end=2.4, confidence=0.9, ignored=True)],
        )
    ]
    assert crossfade_borrow_sec(p, left, right) == pytest.approx(0.02)


@pytest.mark.parametrize("side", ["left", "right"])
def test_a_mute_ending_at_the_clips_own_edge_stops_the_borrow(side: str):
    p = _project()
    left = _clip("a", 1, 2, fade_out_ms=40)
    right = _clip("b", 5, 6, fade_in_ms=40, join_in_mode=ClipJoinMode.CROSSFADE)
    right.timeline_start = 2.0
    p.clips = [left, right]
    if side == "left":
        left.mute_regions = [ClipMuteRegion(start_s=1.2, end_s=2.0)]
    else:
        right.mute_regions = [ClipMuteRegion(start_s=5.0, end_s=5.4)]
    assert crossfade_borrow_sec(p, left, right) == 0.0
    left.mute_regions = [ClipMuteRegion(start_s=1.2, end_s=1.7)]
    right.mute_regions = [ClipMuteRegion(start_s=5.3, end_s=5.5)]
    assert crossfade_borrow_sec(p, left, right) == pytest.approx(0.02)


def test_a_mute_ending_at_the_edge_stops_the_borrow_where_the_bisect_bound_rounds_up():
    p = _project()
    left = _clip("a", 0.574, 2.874, fade_out_ms=40)
    left.mute_regions = [ClipMuteRegion(start_s=0.813, end_s=2.874)]
    right = _clip("b", 2.874, 4, fade_in_ms=40, join_in_mode=ClipJoinMode.CROSSFADE)
    p.clips = [left, right]
    assert MuteIndex(p).room_after(left, 0.02) == 0.0
    assert crossfade_borrow_sec(p, left, right) == 0.0


def test_an_owner_mute_ending_half_a_millisecond_short_of_the_edge_stops_the_borrow():
    p = _project()
    left = _clip("a", 1, 2, fade_out_ms=40)
    left.mute_regions = [ClipMuteRegion(start_s=1.5, end_s=1.9995)]
    right = _clip("b", 2, 3, fade_in_ms=40, join_in_mode=ClipJoinMode.CROSSFADE)
    p.clips = [left, right]
    assert MuteIndex(p).room_after(left, 0.02) == 0.0
    assert crossfade_borrow_sec(p, left, right) == 0.0


def test_an_owner_mute_at_the_edge_is_found_whatever_the_float_rounding():
    rng = random.Random(2048)
    p = _project()
    after_misses = []
    before_misses = []
    for _ in range(4000):
        start = round(rng.uniform(0, 50), 3)
        length = round(rng.uniform(0.5, 5), 3)
        end = round(start + length, 3)
        inner = round(rng.uniform(start + 0.001, end - 0.001), 3)
        clip = _clip("a", start, end)
        clip.mute_regions = [ClipMuteRegion(start_s=inner, end_s=end)]
        p.clips = [clip]
        if MuteIndex(p).room_after(clip, 0.02) != 0.0:
            after_misses.append((start, end, inner))
        clip.mute_regions = [ClipMuteRegion(start_s=start, end_s=inner)]
        if MuteIndex(p).room_before(clip, 0.02) != 0.0:
            before_misses.append((start, end, inner))
    assert after_misses == []
    assert before_misses == []


def test_an_owner_mute_wholly_past_the_source_end_limits_the_borrow():
    p = _project()
    left = _clip("a", 0, 1, fade_out_ms=100)
    left.mute_regions = [ClipMuteRegion(start_s=1.02, end_s=1.05)]
    right = _clip("b", 1, 2, fade_in_ms=100, join_in_mode=ClipJoinMode.CROSSFADE)
    p.clips = [left, right]
    assert MuteIndex(p).room_after(left, 0.05) == pytest.approx(0.02)
    assert crossfade_borrow_sec(p, left, right) == pytest.approx(0.02)


def test_an_owner_mute_wholly_before_the_source_start_limits_the_head_borrow():
    p = _project()
    left = _clip("a", 0, 1, fade_out_ms=100)
    right = _clip("b", 2, 3, fade_in_ms=100, join_in_mode=ClipJoinMode.CROSSFADE)
    right.timeline_start = 1.0
    right.mute_regions = [ClipMuteRegion(start_s=1.9, end_s=1.97)]
    p.clips = [left, right]
    assert MuteIndex(p).room_before(right, 0.05) == pytest.approx(0.03)
    assert crossfade_borrow_sec(p, left, right) == pytest.approx(0.03)


def test_an_owner_mute_straddling_the_edge_gives_no_room():
    p = _project()
    left = _clip("a", 0, 1, fade_out_ms=100)
    left.mute_regions = [ClipMuteRegion(start_s=0.9, end_s=1.1)]
    right = _clip("b", 2, 3, fade_in_ms=100, join_in_mode=ClipJoinMode.CROSSFADE)
    right.timeline_start = 1.0
    right.mute_regions = [ClipMuteRegion(start_s=1.9, end_s=2.1)]
    p.clips = [left, right]
    index = MuteIndex(p)
    assert index.room_after(left, 0.05) == 0.0
    assert index.room_before(right, 0.05) == 0.0


@pytest.mark.parametrize("mode", [ClipJoinMode.CUT, ClipJoinMode.FADE])
def test_a_join_that_is_not_a_crossfade_has_no_block_reason(mode: ClipJoinMode):
    p = _project()
    left = _clip("a", 0, 1, fade_out_ms=20)
    assert (
        crossfade_block_reason(left, _clip("b", 1, 2, fade_in_ms=20, join_in_mode=mode), p) is None
    )
    end = _clip("e", 9, 10, fade_out_ms=20)
    assert crossfade_block_reason(end, _clip("f", 10, 11, join_in_mode=mode), p) is None


@pytest.mark.parametrize("mode", list(ClipJoinMode))
@pytest.mark.parametrize("left_kw", [{}, {"start": 9, "end": 10}, {"source_id": "gone"}])
def test_block_reason_agrees_with_the_join_render_fields(mode: ClipJoinMode, left_kw: dict):
    p = _project()
    kw = dict(left_kw)
    start, end = kw.pop("start", 0), kw.pop("end", 1)
    left = _clip("a", start, end, fade_out_ms=20, **kw)
    right = _clip("b", end, end + 1, fade_in_ms=20, join_in_mode=mode)
    assert (
        crossfade_block_reason(left, right, p)
        == join_render_fields(left, right, p)["join_crossfade_blocked"]
    )


def _aliased_project(*clips: Clip):
    p = _project()
    p.sources = [
        SourceRecording(id="s1", path="h.wav", duration_sec=10),
        SourceRecording(id="s2", path="h.wav", duration_sec=10),
    ]
    p.clips = list(clips)
    p.transcripts = [
        Transcript(
            track_id="host",
            source_id="s2",
            words=[TranscriptWord(text="x", start=4.9, end=5.2, confidence=0.9, ignored=True)],
        )
    ]
    return p


def _aliased_pair():
    left = _clip("a", 3, 5, fade_out_ms=40, source_id="s1")
    right = _clip("b", 5, 7, fade_in_ms=40, join_in_mode=ClipJoinMode.CROSSFADE, source_id="s2")
    return left, right


def test_an_ignored_word_on_an_aliased_neighbour_source_stops_the_borrow():
    left, right = _aliased_pair()
    p = _aliased_project(left, right)
    index = MuteIndex(p)
    assert index.room_after(left, 0.02) == 0.0
    assert index.room_before(right, 0.02) == 0.0
    assert crossfade_borrow_sec(p, left, right) == 0.0


@pytest.mark.parametrize("right_first", [False, True])
def test_the_mute_index_does_not_depend_on_which_source_is_asked_first(right_first: bool):
    left, right = _aliased_pair()
    p = _aliased_project(left, right)
    index = MuteIndex(p)
    if right_first:
        before = index.room_before(right, 0.02)
        after = index.room_after(left, 0.02)
    else:
        after = index.room_after(left, 0.02)
        before = index.room_before(right, 0.02)
    assert (after, before) == (0.0, 0.0)


def _cut_pair(gap_ms: float, xf_ms: int, *, left_len: float = 3.0, **right_kw):
    gap = gap_ms / 1000.0
    x = ClipJoinMode.CROSSFADE
    left = _clip("a", 1.0, 1.0 + left_len, fade_out_ms=xf_ms)
    start = left.source_end + gap
    right = _clip("b", start, start + 3.0, fade_in_ms=xf_ms, join_in_mode=x, **right_kw)
    right.timeline_start = left.timeline_end
    return left, right


@pytest.mark.parametrize(
    ("gap_ms", "xf_ms", "expected"),
    [
        (10, 20, 0.0),
        (20, 20, 0.01),
        (20, 40, 0.01),
        (30, 60, 0.015),
        (80, 200, 0.04),
        (200, 400, 0.1),
        (300, 400, 0.15),
        (400, 400, 0.2),
    ],
)
def test_a_cut_gap_caps_the_borrow_at_half_the_gap(gap_ms: int, xf_ms: int, expected: float):
    left, right = _cut_pair(gap_ms, xf_ms)
    p = _project(left, right)
    assert crossfade_borrow_sec(p, left, right) == pytest.approx(expected)
    room = gap_ms / 2000.0
    if 2 * room + 1e-9 < min(xf_ms / 1000.0, 0.02):
        want = 0.0
    else:
        want = int(min(xf_ms / 2000.0, room) / 0.005 + 1e-9) * 0.005
    assert expected == pytest.approx(want)


def test_a_gap_under_the_minimum_blend_reports_no_headroom():
    left, right = _cut_pair(10, 20)
    p = _project(left, right)
    fields = join_render_fields(left, right, p)
    assert fields["join_crossfade_blocked"] == "no_headroom"
    assert "join_borrow_sec" not in fields


def test_the_float_gap_of_twenty_ms_still_blends():
    left = _clip("a", 1.0, 4.28, fade_out_ms=40)
    right = _clip("b", 4.3, 7.3, fade_in_ms=40, join_in_mode=ClipJoinMode.CROSSFADE)
    assert 4.3 - 4.28 < 0.02
    assert crossfade_borrow_sec(_project(left, right), left, right) == pytest.approx(0.01)


@pytest.mark.parametrize("gap", [0.0, 5e-5, -5e-5])
def test_a_contiguous_source_join_borrows_the_full_half(gap: float):
    left, right = _cut_pair(gap * 1000, 400)
    assert crossfade_borrow_sec(_project(left, right), left, right) == pytest.approx(0.2)


def test_a_raw_gap_just_under_the_splice_eps_is_contiguous_like_is_splice():
    left, right = _cut_pair(9.9999999997e-5 * 1000, 400)
    assert right.source_start - left.source_end < 1e-4
    assert not is_splice(left, right)
    assert crossfade_borrow_sec(_project(left, right), left, right) == pytest.approx(0.2)


def test_a_gap_just_over_the_splice_eps_is_capped():
    left, right = _cut_pair(1.0e-4 * 1000 + 1e-5, 400)
    assert right.source_start - left.source_end >= 1e-4
    assert is_splice(left, right)
    assert crossfade_borrow_sec(_project(left, right), left, right) == 0.0


@pytest.mark.parametrize("gap_ms", [-100, -1000, -3000])
def test_a_negative_source_gap_is_not_capped(gap_ms: int):
    left, right = _cut_pair(gap_ms, 400)
    assert crossfade_borrow_sec(_project(left, right), left, right) == pytest.approx(0.2)


def test_clips_of_different_recordings_have_no_source_gap_to_cap():
    from podcast_mcp.models.episode import SourceRecording

    left, right = _cut_pair(300, 400)
    left.source_id, right.source_id = "s1", "s2"
    p = _project(left, right)
    p.sources = [
        SourceRecording(id="s1", path="one.wav", duration_sec=10),
        SourceRecording(id="s2", path="two.wav", duration_sec=10),
    ]
    assert crossfade_borrow_sec(p, left, right) == pytest.approx(0.2)


def test_other_tracks_of_the_same_source_id_are_not_one_recording():
    left, right = _cut_pair(300, 400)
    right.track_id = "guest"
    assert crossfade_borrow_sec(_project(left, right), left, right) == pytest.approx(0.2)


def test_aliased_source_ids_of_one_file_are_one_recording():
    from podcast_mcp.models.episode import SourceRecording

    left, right = _cut_pair(300, 400)
    left.source_id, right.source_id = "s1", "s2"
    p = _project(left, right)
    p.sources = [
        SourceRecording(id="s1", path="h.wav", duration_sec=10),
        SourceRecording(id="s2", path="h.wav", duration_sec=10),
    ]
    assert crossfade_borrow_sec(p, left, right) == pytest.approx(0.15)


def test_the_quarter_clip_cap_still_wins_over_the_gap_cap():
    left, right = _cut_pair(300, 400, left_len=0.4)
    assert crossfade_borrow_sec(_project(left, right), left, right) == pytest.approx(0.1)


def test_a_mute_nearer_than_half_the_gap_still_wins_over_the_gap_cap():
    left, right = _cut_pair(300, 400)
    near = _clip("c", 8, 9)
    near.mute_regions = [ClipMuteRegion(start_s=4.04, end_s=4.1)]
    p = _project(left, right, near)
    assert crossfade_borrow_sec(p, left, right) == pytest.approx(0.04)


def test_borrowed_spans_never_overlap_inside_a_cut():
    rng = random.Random(2094)
    for _ in range(300):
        gap = rng.choice([rng.uniform(1e-4, 0.05), rng.uniform(0.05, 1.0)])
        ms = rng.choice([20, 40, 100, 200, 400, 1000])
        left, right = _cut_pair(gap * 1000, ms)
        h = crossfade_borrow_sec(_project(left, right), left, right)
        assert left.source_end + h <= right.source_start - h + 1e-9, (gap, ms, h)
