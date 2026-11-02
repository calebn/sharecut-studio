"""The aligner's timing-map producer: steps from lag segments and the window they fit (#2860, 4b)."""

from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.edits.conversation_align import (
    _base_shift,
    _timed_range,
    _timing_for,
    alignment_fingerprint,
    restore_clip_geometry,
    snapshot_clip_geometry,
)
from podcast_mcp.engines.bleed_lag_segments import LagSegment
from podcast_mcp.engines.session_timeline import slip_clip_to_shift
from podcast_mcp.models import Clip, EpisodeProject, ProjectMeta
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
