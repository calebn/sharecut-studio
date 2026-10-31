"""Per-clip timing map: geometry, validators, serialisation and the shared fixture (#2857)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from pydantic import ValidationError

from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    clip_source_to_timeline_shift,
    shift_at,
)
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track
from podcast_mcp.models.clip_timing import ClipTiming
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.timebase import SourceSec as S
from podcast_mcp.util.timebase import TimelineSec as T

_CASES = json.loads((Path(__file__).parent / "fixtures" / "timing_map" / "cases.json").read_text())[
    "cases"
]


def _clip(steps: list[dict], **kw) -> Clip:
    base = {
        "id": "a",
        "track_id": "host",
        "source_start": 10,
        "source_end": 40,
        "timeline_start": 100,
    }
    return Clip.model_validate({**base, **kw, "timing": {"steps": steps}})


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_shared_fixture(case: dict) -> None:
    clip = Clip.model_validate(case["clip"])
    assert clip.timeline_end == pytest.approx(case["timeline_end"])
    assert clip.virtual_pieces() == [pytest.approx(tuple(p)) for p in case["pieces"]]
    for source_s, expected in case["source_to_timeline"]:
        assert clip.source_to_timeline(source_s) == pytest.approx(expected), source_s
    for timeline_s, expected in case["timeline_to_source"]:
        assert clip.timeline_to_source(timeline_s) == pytest.approx(expected), timeline_s
    for source_s, expected in case["shift_at"]:
        assert shift_at(clip, source_s) == pytest.approx(expected), source_s


def test_step_exactly_at_a_point_belongs_to_the_later_piece() -> None:
    clip = _clip([{"at": 20, "delta_sec": 2}])
    assert clip.source_to_timeline(20) == 112
    assert clip.source_to_timeline(math.nextafter(20, 0)) == pytest.approx(110)


def test_hole_and_skipped_span_have_no_counterpart() -> None:
    hole = _clip([{"at": 20, "delta_sec": 2}])
    assert hole.timeline_to_source(111) is None
    skip = _clip([{"at": 20, "delta_sec": -3}])
    assert skip.source_to_timeline(21) is None


def test_without_timing_the_clip_is_one_linear_piece() -> None:
    clip = Clip(id="a", track_id="host", source_start=10, source_end=40, timeline_start=100)
    assert clip.virtual_pieces() == [(10, 40, 100)]
    assert clip.timeline_end == 130
    assert shift_at(clip, 25) == clip_source_to_timeline_shift(clip) == 90


def test_shift_helper_refuses_a_clip_with_timing() -> None:
    clip = _clip([{"at": 20, "delta_sec": 2}])
    with pytest.raises(CodedValueError) as err:
        clip_source_to_timeline_shift(clip)
    assert err.value.code == "timing_map_needs_source_point"


@pytest.mark.parametrize(
    "steps",
    [
        [{"at": 25, "delta_sec": 1}, {"at": 20, "delta_sec": 1}],  # unsorted
        [{"at": 20, "delta_sec": 1}, {"at": 20, "delta_sec": 1}],  # duplicate
        [{"at": 20, "delta_sec": 1}, {"at": 20 + 1e-7, "delta_sec": 1}],  # too close
        [{"at": 20, "delta_sec": -6}, {"at": 25, "delta_sec": 1}],  # skip runs into next step
        [{"at": 20, "delta_sec": 0}],
        [{"at": 5, "delta_sec": 1}],  # before source_start
        [{"at": 10, "delta_sec": 1}],  # source_start is exclusive: the clip's start is the anchor
        [{"at": 40, "delta_sec": 1}],  # source_end is exclusive
        [{"at": 39, "delta_sec": -2}],  # skip runs past source_end
        [{"at": 20, "delta_sec": 1, "quiet": {"start_s": 21, "end_s": 22}}],
        [{"at": 20, "delta_sec": -2, "quiet": {"start_s": 19, "end_s": 21}}],
        [{"at": float("nan"), "delta_sec": 1}],
        [{"at": 20, "delta_sec": float("nan")}],
        [{"at": 20, "delta_sec": float("inf")}],
        [],
    ],
)
def test_invalid_timing_is_rejected(steps: list[dict]) -> None:
    with pytest.raises(ValidationError):
        _clip(steps)


def test_a_skip_ending_exactly_at_the_next_step_or_quiet_edge_is_valid() -> None:
    clip = _clip(
        [
            {"at": 20, "delta_sec": -2, "quiet": {"start_s": 20, "end_s": 22}},
            {"at": 22, "delta_sec": 1},
        ]
    )
    # No zero-length piece between the skip and the step that follows it.
    assert clip.virtual_pieces() == [(10, 20, 100), (22, 40, 111)]


def test_json_round_trip_keeps_timing_and_plain_clips_stay_byte_identical() -> None:
    clip = _clip([{"at": 20, "delta_sec": 2, "quiet": {"start_s": 19, "end_s": 21}}])
    dumped = clip.model_dump_json()
    assert Clip.model_validate_json(dumped) == clip
    assert ClipTiming.model_validate(json.loads(dumped)["timing"]) == clip.timing

    plain = Clip(id="a", track_id="host", source_start=10, source_end=40, timeline_start=100)
    assert "timing" not in plain.model_dump()
    assert plain.model_dump_json() == (
        '{"id":"a","track_id":"host","source_start":10.0,"source_end":40.0,"timeline_start":100.0,'
        '"source_id":null,"fade_in_ms":0,"fade_out_ms":0,"join_in_mode":"fade",'
        '"mute_regions":[]}'
    )


def _project(clips: list[Clip]) -> EpisodeProject:
    project = EpisodeProject.create("timing_test", "/tmp/ws-timing")
    project.timeline.tracks = [
        Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav", duration_sec=300.0))
    ]
    project.timeline.clips = clips
    return project


def test_session_timeline_maps_points_and_spans_through_the_steps() -> None:
    st = SessionTimeline(
        _project([_clip([{"at": 20, "delta_sec": 2}, {"at": 30, "delta_sec": -1}])])
    )
    assert st.source_to_timeline("host", S(15)) == 105
    assert st.source_to_timeline("host", S(25)) == 117
    assert st.source_to_timeline("host", S(30.5)) is None
    assert st.timeline_to_source("host", T(111)) is None
    assert st.timeline_to_source("host", T(118)) == 26
    assert st.map_source_span("host", S(15), S(25)) == [(105, 110), (112, 117)]


def test_lane_clip_spans_emit_one_span_per_virtual_piece() -> None:
    clip = _clip([{"at": 20, "delta_sec": 2}, {"at": 30, "delta_sec": -1}])
    spans = SessionTimeline(_project([clip])).lane_clip_spans("host")
    assert [(s.source_start, s.source_end, s.timeline_start, s.timeline_end) for s in spans] == [
        (10, 20, 100, 110),
        (20, 30, 112, 122),
        (31, 40, 122, 131),
    ]
    assert all(s.clip is clip for s in spans)
