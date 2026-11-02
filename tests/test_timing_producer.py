"""The aligner's timing-map producer: steps from lag segments and the window they fit (#2860, 4b)."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.conversation_align import (
    AlignResult,
    ClipAlignPlan,
    _base_shift,
    _piecewise_plan,
    _timed_range,
    _timing_for,
    alignment_fingerprint,
    apply_alignment_plans,
    restore_clip_geometry,
    snapshot_clip_geometry,
)
from podcast_mcp.engines.bleed_lag_segments import LagSegment, LagSteps
from podcast_mcp.engines.bleed_latency import LatencySettings
from podcast_mcp.engines.session_timeline import slip_clip_to_shift
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, ProjectMeta, Track, TrackRole
from podcast_mcp.models.clip_timing import ClipTiming


def _segment(start: float, shift: float, gap: tuple[float, float] | None = None) -> LagSegment:
    return LagSegment(start_sec=start, shift_sec=shift, frames=100, correlation=0.9, gap_sec=gap)


def _clip(start: float = 0.0, end: float = 240.0, timeline: float = 0.0, **kw) -> Clip:
    return Clip(
        id="c", track_id="t", source_start=start, source_end=end, timeline_start=timeline, **kw
    )


def _timed(*steps: dict) -> ClipTiming:
    return ClipTiming.model_validate({"steps": list(steps)})


def test_base_shift_reads_the_first_piece_of_a_timed_clip() -> None:
    clip = _clip(10.0, 100.0, 4.0, timing=_timed({"at": 50, "delta_sec": 0.5}))

    assert _base_shift(clip) == -6.0
    assert _base_shift(_clip(10.0, 100.0, 4.0)) == -6.0


def test_slip_clip_to_shift_slips_a_timed_clip_by_its_first_shift() -> None:
    clip = _clip(10.0, 100.0, 4.0, timing=_timed({"at": 50, "delta_sec": 0.5}))

    assert slip_clip_to_shift(clip, -5.0, media_duration=0.0) == (9.0, 99.0, 4.0)


@pytest.mark.parametrize(("delta", "at"), [(-0.08, 100.0 - 0.04), (0.08, 100.0 + 0.04)])
def test_the_step_sits_at_mid_plus_half_its_delta_for_both_signs(delta: float, at: float) -> None:
    segments = [_segment(0.0, -0.12), _segment(100.0, -0.12 + delta, (98.0, 102.0))]

    timing, base = _timing_for(_clip(), segments, "note")

    assert timing is not None
    assert base == -0.12
    assert [(s.at, round(s.delta_sec, 9)) for s in timing.steps] == [(at, delta)]
    assert timing.steps[0].quiet.model_dump() == {"start_s": 98.0, "end_s": 102.0}
    assert (timing.method, timing.evidence) == ("bleed_lag", "note")


def test_a_dropped_step_makes_the_next_delta_relative_to_the_last_kept_shift() -> None:
    segments = [
        _segment(0.0, -0.10),
        _segment(60.0, -0.20, None),
        _segment(120.0, -0.30, (118.0, 122.0)),
    ]

    timing, base = _timing_for(_clip(), segments, "")

    assert timing is not None
    assert base == -0.20
    assert [round(s.delta_sec, 9) for s in timing.steps] == [-0.10]


def test_a_quiet_span_outside_the_clip_or_too_short_for_its_step_adds_no_step() -> None:
    segments = [
        _segment(0.0, 0.0),
        _segment(5.0, -0.5, (4.9, 5.1)),
        _segment(100.0, -1.0, (99.9, 100.1)),
        _segment(300.0, -1.5, (299.0, 301.0)),
    ]

    timing, base = _timing_for(_clip(10.0, 240.0), segments, "")

    assert [(timing, base)] == [(None, -1.0)]


def test_a_clip_with_no_step_takes_the_shift_of_the_segment_at_its_middle() -> None:
    segments = [_segment(0.0, -0.1), _segment(100.0, -0.3, (99.0, 101.0))]

    assert _timing_for(_clip(0.0, 80.0), segments, "") == (None, -0.1)
    assert _timing_for(_clip(120.0, 200.0), segments, "") == (None, -0.3)


def test_the_source_end_gives_back_the_total_delta() -> None:
    timing = _timed({"at": 100, "delta_sec": -0.08, "quiet": {"start_s": 99, "end_s": 101}})

    out = _timed_range((0.12, 240.0 - 0.12, 0.0), timing, 240.0)

    assert out is not None
    assert out[:3] == pytest.approx((0.12, 240.0 - 0.12 + 0.08, 0.0))
    assert out[3] is not None
    assert out[4] == 0.0


def test_a_hole_shortens_the_source_end_and_the_media_clamps_it() -> None:
    hole = _timed({"at": 100, "delta_sec": 0.2})
    skip = _timed({"at": 100, "delta_sec": -0.2, "quiet": {"start_s": 99, "end_s": 101}})

    wide = _timed_range((0.0, 240.0, 0.0), hole, 0.0)
    clamped = _timed_range((0.0, 240.0, 0.0), hole, 239.9)
    skipped = _timed_range((0.0, 240.0, 0.0), skip, 240.0)

    assert wide is not None and clamped is not None and skipped is not None
    assert (wide[1], clamped[1], skipped[1]) == pytest.approx((239.8, 239.8, 240.0))
    clamped = _timed_range((0.0, 240.0, 0.0), hole, 239.5)
    assert clamped is not None and clamped[1] == 239.5


def test_a_step_the_final_range_no_longer_holds_is_dropped_and_the_total_recomputed() -> None:
    timing = _timed({"at": 10, "delta_sec": 0.5}, {"at": 239.9, "delta_sec": 0.5})

    out = _timed_range((0.0, 240.0, 0.0), timing, 0.0)

    assert out is not None
    assert out[1] == pytest.approx(239.5)
    assert out[3] is not None and [s.at for s in out[3].steps] == [10]


def test_a_step_at_or_before_the_slipped_start_is_reported_as_head_delta() -> None:
    timing = _timed({"at": 1.0, "delta_sec": 0.5}, {"at": 50.0, "delta_sec": 0.25})

    out = _timed_range((1.5, 200.0, 3.0), timing, 0.0)

    assert out is not None
    assert out[4] == 0.5
    assert out[3] is not None and [s.at for s in out[3].steps] == [50.0]


def test_a_range_with_no_audio_left_is_none() -> None:
    assert _timed_range((5.0, 5.0, 0.0), _timed({"at": 10, "delta_sec": 0.5}), 0.0) is None


def _project(tmp_path: Path, clip: Clip) -> EpisodeProject:
    project = EpisodeProject(meta=ProjectMeta(name="timing", workspace_dir=str(tmp_path)))
    project.clips.append(clip)
    return project


def test_snapshot_and_restore_carry_the_timing(tmp_path: Path) -> None:
    clip = _clip(timing=_timed({"at": 100, "delta_sec": 0.2}))
    project = _project(tmp_path, clip)
    snap = snapshot_clip_geometry(project)

    clip.timing = None
    clip.timeline_start = 3.0
    restore_clip_geometry(project, snap)

    assert clip.timeline_start == 0.0
    assert clip.timing is not None
    assert snap[0][5].steps[0].delta_sec == 0.2


def test_the_fingerprint_changes_with_a_timing_edit_and_not_for_an_untimed_clip(
    tmp_path: Path,
) -> None:
    plain = _project(tmp_path, _clip())
    timed = _project(tmp_path, _clip(timing=_timed({"at": 100, "delta_sec": 0.2})))
    moved = _project(tmp_path, _clip(timing=_timed({"at": 100, "delta_sec": 0.3})))

    assert alignment_fingerprint(plain) == alignment_fingerprint(_project(tmp_path, _clip()))
    assert len({alignment_fingerprint(p) for p in (plain, timed, moved)}) == 3


def _lane(tmp_path: Path, clip: Clip | None = None, *, media: float = 240.0) -> EpisodeProject:
    project = EpisodeProject(meta=ProjectMeta(name="apply", workspace_dir=str(tmp_path)))
    project.tracks.append(
        Track(
            id="t",
            label="T",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/t.wav", duration_sec=media),
        )
    )
    project.clips.append(clip or _clip(0.0, media))
    return project


def _apply(project: EpisodeProject, plan: ClipAlignPlan) -> int:
    result = AlignResult(plans=[plan], reference_track_id=None)
    return apply_alignment_plans(project, result, defaults=load_defaults())


def _skip_step(at: float = 182.77, delta: float = -0.08) -> ClipTiming:
    return _timed({"at": at, "delta_sec": delta, "quiet": {"start_s": at - 1.0, "end_s": at + 1.0}})


def test_apply_times_the_one_clip_and_keeps_its_window(tmp_path: Path) -> None:
    project = _lane(tmp_path)
    plan = ClipAlignPlan("t", "c", -0.12, "bleed_lag", timing=_skip_step())

    assert _apply(project, plan) == 1

    (clip,) = project.clips
    assert (clip.id, clip.source_start, clip.source_end, clip.timeline_start) == (
        "c",
        pytest.approx(0.12),
        240.0,
        0.0,
    )
    assert clip.timing == plan.timing
    assert clip.timeline_end == pytest.approx(239.8)
    assert next(iter(project.meta.ingest_alignment.values())).align_method == "bleed_lag"


def test_apply_gives_a_hole_back_to_the_source_end(tmp_path: Path) -> None:
    project = _lane(tmp_path, _clip(0.0, 230.0, 1.0))
    plan = ClipAlignPlan(
        "t", "c", -0.22, "bleed_lag", timing=_timed({"at": 60.0, "delta_sec": 0.1})
    )

    _apply(project, plan)

    (clip,) = project.clips
    assert clip.source_start == pytest.approx(1.22)
    assert clip.source_end == pytest.approx(230.0 + 1.22 - 0.1)
    assert clip.timeline_end == pytest.approx(231.0)
    assert clip.timeline_start == 1.0


def test_apply_trims_the_head_when_the_shift_passes_the_file_start(tmp_path: Path) -> None:
    project = _lane(tmp_path)
    plan = ClipAlignPlan("t", "c", 0.5, "bleed_lag", timing=_timed({"at": 100.0, "delta_sec": 0.2}))

    _apply(project, plan)

    (clip,) = project.clips
    assert (clip.source_start, clip.timeline_start) == (0.0, 0.5)
    assert clip.source_end == pytest.approx(239.5 - 0.2)


def test_apply_folds_a_step_the_slipped_head_passes_into_the_base_shift(tmp_path: Path) -> None:
    project = _lane(tmp_path, _clip(0.0, 240.0, 10.0))
    timing = _timed({"at": 0.1, "delta_sec": 0.2}, {"at": 100.0, "delta_sec": 0.1})
    plan = ClipAlignPlan("t", "c", 9.0, "bleed_lag", timing=timing)

    _apply(project, plan)

    (clip,) = project.clips
    assert clip.timing is not None and [s.at for s in clip.timing.steps] == [100.0]
    assert plan.offset_sec == pytest.approx(9.2)


def test_apply_with_no_timing_clears_it_and_keeps_the_window(tmp_path: Path) -> None:
    timed = _clip(0.12, 240.0, 0.0, timing=_skip_step())
    project = _lane(tmp_path, timed)
    window = timed.timeline_end

    _apply(project, ClipAlignPlan("t", "c", -0.12, "bleed_lag"))

    (clip,) = project.clips
    assert clip.timing is None
    assert clip.timeline_end == pytest.approx(window)
    assert clip.source_start == pytest.approx(0.12)


def test_apply_leaves_a_timed_clip_alone_for_a_plan_that_is_not_bleed_lag(tmp_path: Path) -> None:
    timed = _clip(0.12, 240.0, 0.0, timing=_skip_step())
    project = _lane(tmp_path, timed)
    before = timed.model_dump()

    _apply(project, ClipAlignPlan("t", "c", 0.0, "bleed_lag_kept"))

    assert project.clips[0].model_dump() == before


def test_apply_skips_the_lane_when_the_slip_leaves_no_audio(tmp_path: Path) -> None:
    project = _lane(tmp_path, _clip(0.0, 5.0, 0.0), media=5.0)
    plan = ClipAlignPlan("t", "c", -9.0, "bleed_lag", timing=_timed({"at": 2.0, "delta_sec": 0.1}))

    assert _apply(project, plan) == 0

    assert plan.skipped_reason
    assert project.clips[0].timing is None
    assert project.clips[0].source_end == 5.0


def test_a_timed_rerun_over_the_same_lane_is_kept_and_a_changed_lane_is_not(
    tmp_path: Path,
) -> None:
    segments = (_segment(0.0, -0.12), _segment(182.81, -0.2, (152.5, 213.0)))
    lane = LagSteps(segments=segments, step_cost=0.5)
    settings = LatencySettings()
    base = ClipAlignPlan("t", "c", 0.0, "hold")
    first = _piecewise_plan(base, _clip(), lane, 0.0, settings)
    clip = _clip(0.12, 240.0, 0.0, timing=first.timing)

    again = _piecewise_plan(base, clip, lane, 0.0, settings)
    moved = _piecewise_plan(
        base,
        clip,
        LagSteps((segments[0], _segment(182.81, -0.3, (152.5, 213.0))), 0.5),
        0.0,
        settings,
    )

    assert (first.method, again.method, moved.method) == (
        "bleed_lag",
        "bleed_lag_kept",
        "bleed_lag",
    )
    assert again.offset_sec == pytest.approx(-0.12)


def test_a_legacy_piece_whose_edge_cuts_the_quiet_span_gets_no_timing() -> None:
    segments = [_segment(0.0, -0.12), _segment(182.81, -0.2, (152.5, 213.0))]

    left, right = _clip(0.12, 182.65, 0.0), _clip(182.85, 240.0, 182.65)

    assert [_timing_for(piece, segments, "")[0] for piece in (left, right)] == [None, None]
