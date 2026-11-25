"""Split, trim limits and roll limits on a clip with a timing map (#2859, umbrella #1089)."""

from __future__ import annotations

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits import ripple
from podcast_mcp.edits.ripple import apply_trim_geometry, plan_trim
from podcast_mcp.edits.timeline_ops import split_clips_at
from podcast_mcp.engines import clips_ops
from podcast_mcp.engines.clips_ops import (
    move_clips,
    punch_timeline_range_from_clips,
    remove_timeline_range_from_clips,
    roll_clip_join,
    roll_join_limits,
    split_clip_at,
    trim_edge_limits,
)
from podcast_mcp.models import Clip, EditMode, EpisodeProject, MediaAsset, Track
from podcast_mcp.util.coded_error import CodedValueError

_DEFAULTS = load_defaults()


def _q(start: float, end: float) -> dict:
    return {"start_s": start, "end_s": end}


def _clip(steps: list[dict], **kw) -> Clip:
    base = {
        "id": "a",
        "track_id": "host",
        "source_start": 10,
        "source_end": 40,
        "timeline_start": 100,
    }
    return Clip.model_validate({**base, **kw, "timing": {"steps": steps}})


def _project(clips: list[Clip]) -> EpisodeProject:
    project = EpisodeProject.create("timed_edits", "/tmp/ws-timed-edits")
    project.timeline.tracks = [
        Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav", duration_sec=300.0))
    ]
    project.timeline.clips = clips
    return project


# A hole of 2 s at source 20 and a skip of 1 s at source 30 (pieces 10-20, 20-30, 31-40).
_STEPS = [{"at": 20, "delta_sec": 2}, {"at": 30, "delta_sec": -1, "quiet": _q(29, 32)}]


def _played(*clips: Clip) -> list[tuple[float, float, float]]:
    return [piece for clip in clips for piece in clip.virtual_pieces()]


def test_a_split_inside_a_piece_keeps_every_played_second_where_it_was() -> None:
    clip = _clip(_STEPS)
    before, after = split_clip_at(clip, 115.0, defaults=_DEFAULTS)
    assert _played(before, after) == [
        (10, 20, 100),
        (20, 23, 112),
        (23, 30, 115),
        (31, 40, 122),
    ]
    assert before.timeline_end == 115
    assert after.timeline_start == 115
    assert after.timeline_end == clip.timeline_end


def test_each_half_keeps_only_the_steps_inside_its_own_source_range() -> None:
    before, after = split_clip_at(_clip(_STEPS), 105.0, defaults=_DEFAULTS)
    assert before.timing is None
    assert after.timing is not None
    assert [step.at for step in after.timing.steps] == [20, 30]

    before, after = split_clip_at(_clip(_STEPS), 125.0, defaults=_DEFAULTS)
    assert before.timing is not None
    assert [step.at for step in before.timing.steps] == [20, 30]
    assert after.timing is None


def test_a_split_inside_a_hole_leaves_the_hole_as_the_gap_between_the_clips() -> None:
    clip = _clip(_STEPS)
    before, after = split_clip_at(clip, 111.0, defaults=_DEFAULTS)
    assert (before.source_end, after.source_start) == (20, 20)
    assert before.timeline_end == 110
    assert after.timeline_start == 112
    assert before.timing is None
    assert after.timing is not None
    assert [step.at for step in after.timing.steps] == [30]
    assert after.timeline_end == clip.timeline_end


def test_a_split_exactly_on_a_step_drops_that_step_and_keeps_the_audio_in_place() -> None:
    clip = _clip(_STEPS)
    before, after = split_clip_at(clip, 112.0, defaults=_DEFAULTS)
    assert (before.source_end, after.source_start) == (20, 20)
    assert after.timeline_start == 112
    assert _played(before, after) == [*_played(clip)[:1], (20, 30, 112), (31, 40, 122)]


def test_a_split_at_the_join_after_a_skip_ends_the_left_clip_past_the_skipped_span() -> None:
    clip = _clip(_STEPS)
    before, after = split_clip_at(clip, 122.0, defaults=_DEFAULTS)
    assert (before.source_end, after.source_start) == (31, 31)
    assert before.timeline_end == 122
    assert after.timeline_start == 122
    assert after.timing is None
    assert [step.at for step in before.timing.steps] == [20, 30]


def test_a_split_outside_the_clip_is_still_refused() -> None:
    with pytest.raises(CodedValueError) as err:
        split_clip_at(_clip(_STEPS), 100.0, defaults=_DEFAULTS)
    assert err.value.code == "split_outside_clip"
    with pytest.raises(CodedValueError):
        split_clip_at(_clip(_STEPS), 131.0, defaults=_DEFAULTS)


def test_a_clip_without_timing_splits_as_before() -> None:
    clip = Clip(id="a", track_id="host", source_start=10, source_end=40, timeline_start=100)
    before, after = split_clip_at(clip, 115.0, defaults=_DEFAULTS)
    assert (before.source_end, after.source_start, after.timeline_start) == (25, 25, 115)
    assert before.timing is None and after.timing is None


def test_trim_limits_stop_the_in_edge_at_the_first_step_and_the_out_edge_after_the_last() -> None:
    clip = _clip(_STEPS)
    project = _project([clip])
    _in_lo, in_hi = trim_edge_limits(project, clip, "in", EditMode.RIPPLE)
    assert in_hi == pytest.approx(20, abs=1e-5)
    assert in_hi < 20
    out_lo, out_hi = trim_edge_limits(project, clip, "out", EditMode.RIPPLE)
    assert out_lo == pytest.approx(31, abs=1e-5)
    assert out_lo > 31
    assert out_hi == 300


def test_trim_limits_are_unchanged_for_a_clip_without_timing() -> None:
    clip = Clip(id="a", track_id="host", source_start=10, source_end=40, timeline_start=100)
    project = _project([clip])
    assert trim_edge_limits(project, clip, "in", EditMode.RIPPLE)[1] == pytest.approx(39.95)
    assert trim_edge_limits(project, clip, "out", EditMode.RIPPLE)[0] == pytest.approx(10.05)


def test_a_roll_stops_at_the_nearest_step_on_each_side() -> None:
    left = _clip([{"at": 20, "delta_sec": 2}], id="l", source_start=10, source_end=30)
    right = Clip.model_validate(
        {
            "id": "r",
            "track_id": "host",
            "source_start": 30,
            "source_end": 60,
            "timeline_start": left.timeline_end,
            "timing": {"steps": [{"at": 50, "delta_sec": 1}]},
        }
    )
    project = _project([left, right])
    neg, pos = roll_join_limits(project, "l", "r")
    assert neg == pytest.approx(-(30 - 20), abs=1e-5)
    assert pos == pytest.approx(50 - 30, abs=1e-5)


def test_rolling_to_the_limit_keeps_both_clips_valid_and_flush() -> None:
    left = _clip([{"at": 20, "delta_sec": 2}], id="l", source_start=10, source_end=30)
    right = Clip.model_validate(
        {
            "id": "r",
            "track_id": "host",
            "source_start": 30,
            "source_end": 60,
            "timeline_start": left.timeline_end,
            "timing": {"steps": [{"at": 50, "delta_sec": 1}]},
        }
    )
    project = _project([left, right])
    new_left, new_right = roll_clip_join(project, "l", "r", 1000.0)
    assert new_right.source_start < 50
    assert new_right.timeline_start == new_left.timeline_end
    new_left, new_right = roll_clip_join(project, "l", "r", -1000.0)
    assert new_left.source_end > 20
    assert new_right.timeline_start == new_left.timeline_end
    Clip.model_validate(new_left.model_dump())
    Clip.model_validate(new_right.model_dump())


def test_removing_a_range_across_a_step_closes_the_time_and_keeps_later_audio_in_sync() -> None:
    clip = _clip(_STEPS)
    out = remove_timeline_range_from_clips([clip], 108.0, 115.0, defaults=_DEFAULTS)
    assert out[0].timeline_end == 108
    assert out[-1].timeline_end == pytest.approx(clip.timeline_end - 7.0)
    played = _played(*out)
    assert played[-1] == (31, 40, 122 - 7)
    assert (23, 30, 108) in played


def test_a_punch_keeps_the_timeline_length_and_the_audio_after_it_in_place() -> None:
    clip = _clip(_STEPS)
    out = punch_timeline_range_from_clips([clip], 108.0, 115.0, defaults=_DEFAULTS)
    assert out[-1].timeline_end == clip.timeline_end
    assert _played(*out)[-1] == (31, 40, 122)


def test_edits_leave_the_original_clip_untouched_so_undo_can_restore_it() -> None:
    clip = _clip(_STEPS)
    snapshot = clip.model_dump()
    split_clip_at(clip, 115.0, defaults=_DEFAULTS)
    remove_timeline_range_from_clips([clip], 108.0, 115.0, defaults=_DEFAULTS)
    punch_timeline_range_from_clips([clip], 108.0, 115.0, defaults=_DEFAULTS)
    assert clip.model_dump() == snapshot


@pytest.mark.parametrize("span", [(110.5, 111.5), (110.0, 112.0), (110.0, 111.0), (111.0, 112.0)])
def test_a_range_wholly_inside_a_hole_shrinks_the_hole_when_removed(
    span: tuple[float, float],
) -> None:
    clip = _clip(_STEPS)
    out = remove_timeline_range_from_clips([clip], *span, defaults=_DEFAULTS)
    shrink = span[1] - span[0]
    assert out[-1].timeline_end == pytest.approx(clip.timeline_end - shrink)
    assert _played(*out)[-1] == (31, 40, 122 - shrink)
    assert out[0].timeline_end == 110


@pytest.mark.parametrize("span", [(110.5, 111.5), (110.0, 112.0)])
def test_a_range_wholly_inside_a_hole_changes_nothing_when_punched(
    span: tuple[float, float],
) -> None:
    clip = _clip(_STEPS)
    out = punch_timeline_range_from_clips([clip], *span, defaults=_DEFAULTS)
    assert out[-1].timeline_end == clip.timeline_end
    assert _played(*out)[-1] == (31, 40, 122)


def test_a_slice_drops_a_skip_that_would_cross_its_end() -> None:
    timing = _clip([{"at": 30, "delta_sec": -5, "quiet": _q(29, 36)}]).timing
    assert timing is not None
    assert timing.sliced(10, 33) is None
    kept = timing.sliced(10, 36.5)
    assert kept is not None and [step.at for step in kept.steps] == [30]


def test_a_range_straddling_the_start_of_a_hole_removes_the_audio_and_part_of_the_hole() -> None:
    clip = _clip(_STEPS)
    out = remove_timeline_range_from_clips([clip], 108.0, 111.0, defaults=_DEFAULTS)
    assert out[0].timeline_end == 108
    assert _played(*out)[-1] == (31, 40, 122 - 3)
    assert (20, 30, 109) in _played(*out)


def test_a_range_straddling_the_end_of_a_hole_removes_part_of_the_hole_and_the_audio() -> None:
    clip = _clip(_STEPS)
    out = remove_timeline_range_from_clips([clip], 111.0, 114.0, defaults=_DEFAULTS)
    assert out[0].timeline_end == 110
    assert _played(*out)[-1] == (31, 40, 122 - 3)
    assert (22, 30, 111) in _played(*out)


def test_rolling_a_join_stops_after_a_skip_at_the_end_of_the_left_clip() -> None:
    left = _clip([{"at": 20, "delta_sec": -2, "quiet": _q(19, 23)}], id="l", source_end=30)
    right = Clip.model_validate(
        {
            "id": "r",
            "track_id": "host",
            "source_start": 30,
            "source_end": 60,
            "timeline_start": left.timeline_end,
        }
    )
    project = _project([left, right])
    neg, _ = roll_join_limits(project, "l", "r")
    assert neg == pytest.approx(-(30 - 22), abs=1e-5)


def test_trim_limits_in_gap_mode_still_stop_at_the_steps() -> None:
    clip = _clip(_STEPS)
    project = _project([clip])
    assert trim_edge_limits(project, clip, "in", EditMode.GAP)[1] < 20
    assert trim_edge_limits(project, clip, "out", EditMode.GAP)[0] > 31


def test_timing_hole_split_reports_the_mutation_owned_right_piece() -> None:
    project = _project([_clip(_STEPS)])
    result = split_clips_at(project, 111.0, ["host"], record_log=False, defaults=_DEFAULTS)
    right = next(c for c in project.clips if c.timeline_start == 112.0)
    assert result["split_pieces"] == [
        {
            "track_id": "host",
            "original_clip_id": "a",
            "left_clip_id": next(c.id for c in project.clips if c.timeline_end == 110.0),
            "right_clip_id": right.id,
        }
    ]


def _follower() -> Clip:
    return Clip(id="n", track_id="host", source_start=100, source_end=110, timeline_start=125)


@pytest.mark.parametrize("mode", [EditMode.RIPPLE, EditMode.GAP])
@pytest.mark.parametrize(("edge", "sec"), [("out", 0.0), ("in", 1000.0)])
def test_trimming_past_the_step_limit_stops_at_it_and_keeps_the_steps(
    mode: EditMode, edge: str, sec: float
) -> None:
    clip = _clip(_STEPS)
    follower = _follower()
    project = _project([clip, follower])
    plan = plan_trim(project, "a", edge, sec, mode)
    apply_trim_geometry(project, plan, defaults=_DEFAULTS)
    trimmed = next(c for c in project.clips if c.id == "a")
    moved = next(c for c in project.clips if c.id == "n")
    assert trimmed.timing == clip.timing
    assert Clip.model_validate(trimmed.model_dump()).timing == clip.timing
    if edge == "out":
        assert 31 < trimmed.source_end < 31.001
    else:
        assert 19.999 < trimmed.source_start < 20
    if mode is EditMode.GAP and edge == "in":
        assert trimmed.timeline_start == pytest.approx(100 + trimmed.source_start - 10)
        assert trimmed.timeline_end == pytest.approx(clip.timeline_end)
    else:
        assert trimmed.timeline_end == pytest.approx(clip.timeline_end + plan.delta)
    ripples = mode is EditMode.RIPPLE
    assert moved.timeline_start == pytest.approx(125 + (plan.delta if ripples else 0))


@pytest.mark.parametrize(
    ("span", "removed", "punched"),
    [
        (
            (108.0, 110.0),
            [(10, 18, 100), (20, 30, 110), (31, 40, 120)],
            [(10, 18, 100), (20, 30, 112), (31, 40, 122)],
        ),
        (
            (112.0, 114.0),
            [(10, 20, 100), (22, 30, 112), (31, 40, 120)],
            [(10, 20, 100), (22, 30, 114), (31, 40, 122)],
        ),
        (
            (121.0, 123.0),
            [(10, 20, 100), (20, 29, 112), (32, 40, 121)],
            [(10, 20, 100), (20, 29, 112), (32, 40, 123)],
        ),
    ],
    ids=["ends_on_a_step", "starts_on_a_step", "equals_the_quiet_span"],
)
def test_a_cut_on_a_step_or_over_a_quiet_span_keeps_the_audio_in_place(
    span: tuple[float, float],
    removed: list[tuple[float, float, float]],
    punched: list[tuple[float, float, float]],
) -> None:
    for cut, expected in (
        (remove_timeline_range_from_clips, removed),
        (punch_timeline_range_from_clips, punched),
    ):
        out = cut([_clip(_STEPS)], *span, defaults=_DEFAULTS)
        assert _played(*out) == expected
        for piece in out:
            Clip.model_validate(piece.model_dump())


def test_moving_a_timed_clip_keeps_its_steps_and_shifts_every_piece() -> None:
    clip = _clip(_STEPS)
    timing = clip.timing.model_copy(deep=True)
    before = _played(clip)
    project = _project([clip])
    (moved,) = move_clips(project, [{"clip_id": "a", "timeline_start": 500.0, "track_id": "host"}])
    assert moved.timing == timing
    assert _played(moved) == [(a, b, at + 400) for a, b, at in before]
    assert moved.timeline_end == 131 + 400


def test_a_bypassed_clamp_cannot_save_a_step_outside_the_clip(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(clips_ops, "roll_join_limits", lambda *a, **k: (-1000.0, 1000.0))
    left = _clip([{"at": 20, "delta_sec": 2}], id="l", source_end=30)
    right = _clip(
        [{"at": 50, "delta_sec": 1}],
        id="r",
        source_start=30,
        source_end=60,
        timeline_start=left.timeline_end,
    )
    project = _project([left, right])
    for delta in (-15.0, 25.0):
        with pytest.raises(ValueError, match="outside"):
            roll_clip_join(project, "l", "r", delta)
        assert (left.source_end, right.source_start) == (30, 30)

    monkeypatch.setattr(ripple, "trim_edge_limits", lambda *a, **k: (-1000.0, 1000.0))
    trim_clip = _clip(_STEPS)
    trim_project = _project([trim_clip])
    for edge, sec in (("out", 25.0), ("in", 25.0)):
        plan = plan_trim(trim_project, "a", edge, sec, EditMode.RIPPLE)
        with pytest.raises(ValueError, match="outside"):
            apply_trim_geometry(trim_project, plan, defaults=_DEFAULTS)
        (kept,) = trim_project.timeline.clips
        assert (kept.source_start, kept.source_end) == (10, 40)
        assert kept.timing == trim_clip.timing


def test_a_trim_with_no_legal_range_is_refused_with_a_clear_error() -> None:
    clip = _clip([{"at": 20, "delta_sec": 2}], source_end=40)
    neighbour = Clip(
        id="n", track_id="host", source_start=12, source_end=50, timeline_start=clip.timeline_end
    )
    project = _project([clip, neighbour])
    with pytest.raises(CodedValueError) as excinfo:
        plan_trim(project, "a", "out", 35.0, EditMode.RIPPLE)
    assert excinfo.value.code == "trim_no_legal_range"
    assert (clip.source_start, clip.source_end) == (10, 40)
