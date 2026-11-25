"""Ducking: the pure engine, the timeline projection, the command, the CLI and the MCP tool."""

from __future__ import annotations

import itertools
import json
import math
import random
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

from podcast_mcp.cli.main import app
from podcast_mcp.engines.ducking import (
    BASE_PREFIX,
    GENERATED_PREFIX,
    USER_PREFIX,
    DuckingParams,
    EnvPoint,
    dialogue_activity,
    dialogue_sources,
    duck_polyline,
    generated_point_id,
    plan_envelope,
    plan_token,
    restore_base,
    speech_regions,
)
from podcast_mcp.engines.render_invalidations import reason_for_operation
from podcast_mcp.mcp import server as mcp_server
from podcast_mcp.models import (
    AutomationEnvelope,
    AutomationPoint,
    Clip,
    ClipMuteRegion,
    ClipOffSpeakerMuteRegion,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
    Transcript,
    TranscriptWord,
    load_project,
    save_project,
)
from podcast_mcp.models.episode import SegmentRef
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService
from podcast_mcp.services.document_sync import DocumentSyncService, submit_host_command_result
from podcast_mcp.services.document_sync.ducking import plan_ducking, select_targets
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.document_sync.payloads import ENVELOPE_POINTS_MAX, validate_payload
from podcast_mcp.services.pipeline import PipelineService
from podcast_mcp.util.coded_error import CodedValueError

runner = CliRunner()
DEPTH = -18.0
GAIN = math.pow(10.0, DEPTH / 20.0)


def params(**overrides: float) -> DuckingParams:
    return DuckingParams(depth_db=overrides.pop("depth_db", DEPTH), **overrides)


def at(points: list[EnvPoint], time: float) -> float:
    ordered = sorted(points, key=lambda p: p.time)
    if not ordered:
        return 1.0
    if time <= ordered[0].time:
        return ordered[0].value
    for left, right in itertools.pairwise(ordered):
        if time < right.time:
            span = right.time - left.time
            return left.value + (right.value - left.value) * (time - left.time) / span
    return ordered[-1].value


def poly_at(poly: list[tuple[float, float]], time: float) -> float:
    return at([EnvPoint("", t, v) for t, v in poly], time)


def plan(spans, current=(), duration=60.0, max_points=ENVELOPE_POINTS_MAX, **overrides):
    return plan_envelope(spans, list(current), params(**overrides), duration, max_points)


class TestSpeechRegions:
    def test_blips_shorter_than_min_speech_do_not_duck(self) -> None:
        assert speech_regions([(5.0, 5.05), (9.0, 10.0)], params(), 60.0) == [(9.0, 10.0)]

    def test_runs_closer_than_the_hold_are_bridged(self) -> None:
        assert speech_regions([(5.0, 6.0), (6.3, 7.0)], params(), 60.0) == [(5.0, 7.0)]

    def test_dips_merge_until_the_bed_gets_min_gap_at_full_level(self) -> None:
        p = params()
        needed = p.attack_sec + p.hold_sec + p.release_sec + p.min_gap_sec
        close = [(5.0, 6.0), (6.0 + needed - 0.05, 7.0 + needed)]
        far = [(5.0, 6.0), (6.0 + needed + 0.05, 7.0 + needed)]
        assert len(speech_regions(close, p, 60.0)) == 1
        assert len(speech_regions(far, p, 60.0)) == 2

    def test_spans_are_clamped_to_the_timeline(self) -> None:
        assert speech_regions([(-1.0, 2.0), (58.0, 70.0)], params(), 60.0) == [
            (0.0, 2.0),
            (58.0, 60.0),
        ]


class TestShape:
    def test_one_region_is_four_points_and_the_ramp_ends_on_the_first_word(self) -> None:
        result = plan([(10.0, 12.0)])
        assert [(p.time, round(p.value, 6)) for p in result.points] == [
            (9.75, 1.0),
            (10.0, round(GAIN, 6)),
            (12.35, round(GAIN, 6)),
            (13.15, 1.0),
        ]
        assert result.generated == 4 and result.lowered == 0

    def test_first_ramp_cut_by_time_zero_keeps_its_slope(self) -> None:
        result = plan([(0.1, 2.0)])
        first = result.points[0]
        assert first.time == 0.0
        assert first.value == pytest.approx(1.0 + (GAIN - 1.0) * (0.25 - 0.1) / 0.25)
        assert 0.0 < first.value < 1.0

    def test_speech_at_time_zero_starts_at_depth(self) -> None:
        assert plan([(0.0, 2.0)]).points[0] == EnvPoint(
            generated_point_id(0.0, GAIN), 0.0, pytest.approx(GAIN)
        )

    def test_last_ramp_cut_by_the_end_keeps_its_slope(self) -> None:
        result = plan([(58.0, 59.0)], duration=60.0)
        last = result.points[-1]
        assert last.time == 60.0
        assert GAIN < last.value < 1.0
        assert last.value == pytest.approx(GAIN + (1.0 - GAIN) * (60.0 - 59.35) / 0.8)

    def test_speech_running_to_the_end_holds_the_dip_to_the_end(self) -> None:
        last = plan([(58.0, 59.8)], duration=60.0).points[-1]
        assert last == EnvPoint(generated_point_id(60.0, GAIN), 60.0, pytest.approx(GAIN))

    def test_depth_zero_or_no_speech_writes_no_points(self) -> None:
        assert plan([(10.0, 12.0)], depth_db=0.0).points == []
        assert plan([]).points == []

    def test_depth_zero_removes_an_earlier_dip_and_restores_lowered_points(self) -> None:
        user = [EnvPoint("u", 10.5, 0.9)]
        ducked = plan([(10.0, 12.0)], user)
        assert ducked.lowered == 1
        undone = plan([(10.0, 12.0)], ducked.points, depth_db=0.0)
        assert undone.points == user
        assert undone.replaced_generated == ducked.generated

    def test_ids_are_hash_derived_and_stable(self) -> None:
        a = plan([(10.0, 12.0)]).points
        b = plan([(10.0, 12.0)]).points
        assert a == b
        assert all(p.id == generated_point_id(p.time, p.value) for p in a)
        assert all(p.id.startswith(GENERATED_PREFIX) for p in a)

    def test_the_plan_token_changes_with_the_points(self) -> None:
        one = {"music": plan([(10.0, 12.0)]).points}
        two = {"music": plan([(10.0, 13.0)]).points}
        assert plan_token(one) == plan_token(dict(one))
        assert plan_token(one) != plan_token(two)

    def test_invalid_settings_are_refused(self) -> None:
        with pytest.raises(CodedValueError) as raised:
            plan([(1.0, 2.0)], depth_db=3.0)
        assert raised.value.code == "ducking_bad_param"
        with pytest.raises(CodedValueError):
            plan([(1.0, 2.0)], attack_sec=-1.0)


class TestComposition:
    def test_a_fade_in_during_speech_at_time_zero_is_never_raised(self) -> None:
        fade = [EnvPoint("f0", 0.0, 0.0), EnvPoint("f1", 2.0, 1.0), EnvPoint("f2", 50.0, 1.0)]
        result = plan([(0.0, 3.0)], fade)
        for time in (0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0):
            assert at(result.points, time) <= at(fade, time) + 1e-9
            assert at(result.points, time) <= max(at(fade, time), 0.0) + 1e-9
        assert at(result.points, 1.0) == pytest.approx(min(0.5, GAIN))
        assert result.points[0].id == "f0"
        assert any(p.id == "f1" for p in result.points) or any(
            p.id.startswith(BASE_PREFIX + "f1:") for p in result.points
        )

    def test_the_minimum_is_exact_where_the_lines_cross(self) -> None:
        base = [EnvPoint("a", 0.0, 1.0), EnvPoint("b", 30.0, 0.0)]
        result = plan([(10.0, 12.0)], base)
        poly = duck_polyline([(10.0, 12.0)], params(), 60.0)
        for time in [i * 0.05 for i in range(0, 700)]:
            expected = min(at(base, time), poly_at(poly, time))
            assert at(result.points, time) == pytest.approx(expected, abs=1e-4)

    def test_a_user_point_inside_the_dip_is_lowered_and_remembered(self) -> None:
        result = plan([(10.0, 12.0)], [EnvPoint("mine", 11.0, 0.8)])
        lowered = next(p for p in result.points if p.time == 11.0)
        assert lowered.id == f"{BASE_PREFIX}mine:0.8:{lowered.value!r}"
        assert lowered.value == pytest.approx(GAIN)
        assert result.lowered == 1 and result.kept_user_points == 1

    def test_a_user_point_below_the_dip_stays_as_it_is(self) -> None:
        result = plan([(10.0, 12.0)], [EnvPoint("quiet", 11.0, 0.01)])
        assert EnvPoint("quiet", 11.0, 0.01) in result.points

    def test_a_boost_above_unity_stays_where_no_dip_applies(self) -> None:
        result = plan([(10.0, 12.0)], [EnvPoint("loud", 50.0, 1.5)])
        assert EnvPoint("loud", 50.0, 1.5) in result.points
        assert at(result.points, 30.0) == pytest.approx(1.5)
        assert at(result.points, 50.0) == pytest.approx(1.5)
        assert at(result.points, 11.0) == pytest.approx(GAIN)
        assert max(p.value for p in result.points) <= 1.5

    def test_a_boost_is_lowered_only_where_the_dip_is_below_it(self) -> None:
        result = plan([(10.0, 12.0)], [EnvPoint("loud", 11.0, 1.5)])
        assert at(result.points, 11.0) == pytest.approx(GAIN)
        assert at(result.points, 40.0) == pytest.approx(1.5)
        assert max(p.value for p in result.points) <= 1.5
        again = plan([(10.0, 12.0)], result.points)
        assert again.points == result.points
        assert plan([(10.0, 12.0)], result.points, depth_db=0.0).points == [
            EnvPoint("loud", 11.0, 1.5)
        ]

    def test_a_retyped_lowered_point_is_the_persons_and_not_reverted(self) -> None:
        first = plan([(10.0, 12.0)], [EnvPoint("mine", 11.0, 0.8)])
        lowered = next(p for p in first.points if p.id.startswith(BASE_PREFIX))
        retyped = [EnvPoint(p.id, p.time, 0.05) if p.id == lowered.id else p for p in first.points]
        again = plan([(10.0, 12.0)], retyped)
        assert at(again.points, 11.0) == pytest.approx(0.05)
        assert EnvPoint("mine", 11.0, 0.05) in again.points
        assert plan([(10.0, 12.0)], again.points).points == again.points
        flat = plan([(10.0, 12.0)], retyped, depth_db=0.0)
        assert flat.points == [EnvPoint("mine", 11.0, 0.05)]

    def test_a_point_retyped_above_the_dip_keeps_the_typed_value_as_its_base(self) -> None:
        first = plan([(10.0, 12.0)], [EnvPoint("mine", 11.0, 0.8)])
        lowered = next(p for p in first.points if p.id.startswith(BASE_PREFIX))
        retyped = [EnvPoint(p.id, p.time, 0.5) if p.id == lowered.id else p for p in first.points]
        flat = plan([(10.0, 12.0)], retyped, depth_db=0.0)
        assert flat.points == [EnvPoint("mine", 11.0, 0.5)]

    def test_editing_one_generated_point_does_not_collapse_the_bed(self) -> None:
        spans = [(10.0, 12.0), (16.0, 17.0), (40.0, 41.0)]
        first = plan(spans)
        target = next(p for p in first.points if p.time == 10.0)
        assert target.value == pytest.approx(GAIN)
        edited = [EnvPoint(p.id, p.time, 0.063) if p.id == target.id else p for p in first.points]
        again = plan(spans, edited)
        assert at(again.points, 10.0) == pytest.approx(0.063)
        for time in (16.5, 40.5):
            assert at(again.points, time) == pytest.approx(GAIN, abs=1e-6)
        for time in (0.0, 5.0, 9.0, 25.0, 30.0, 50.0, 59.0):
            assert at(again.points, time) == pytest.approx(1.0)
        assert plan(spans, again.points).points == again.points
        others = [p for p in first.points if p.id != target.id]
        assert at(first.points, 11.0) == at(plan(spans, others).points, 11.0)

    def test_a_point_past_the_timeline_end_is_left_exactly_as_saved(self) -> None:
        stale = EnvPoint("late", 90.0, 1.0)
        result = plan([(58.0, 59.5)], [stale], duration=60.0)
        assert stale in result.points

    def test_a_hand_edited_generated_point_survives_as_a_user_point(self) -> None:
        first = plan([(10.0, 12.0)])
        moved = first.points[1]
        edited = [
            *first.points[:1],
            EnvPoint(moved.id, moved.time + 0.5, moved.value),
            *first.points[2:],
        ]
        base, dropped = restore_base(edited)
        assert dropped == 3
        assert base == [
            EnvPoint(USER_PREFIX + moved.id[len(GENERATED_PREFIX) :], 10.5, moved.value)
        ]
        again = plan([(10.0, 12.0)], edited)
        assert len({p.id for p in again.points}) == len(again.points)
        assert again.kept_user_points == 1
        assert at(again.points, 30.0) == pytest.approx(1.0)

    def test_a_lowered_point_is_restored_before_a_rerun_with_another_depth(self) -> None:
        user = [EnvPoint("mine:with:colons", 11.0, 0.8)]
        deep = plan([(10.0, 12.0)], user, depth_db=-30.0)
        shallow = plan([(10.0, 12.0)], deep.points, depth_db=-6.0)
        assert shallow.points == plan([(10.0, 12.0)], user, depth_db=-6.0).points
        assert at(shallow.points, 11.0) == pytest.approx(math.pow(10.0, -6.0 / 20.0))

    def test_rerun_is_idempotent(self) -> None:
        user = [EnvPoint("a", 0.0, 0.0), EnvPoint("b", 2.0, 1.0), EnvPoint("c", 11.0, 0.7)]
        first = plan([(0.0, 3.0), (10.0, 12.0), (30.0, 31.0)], user)
        second = plan([(0.0, 3.0), (10.0, 12.0), (30.0, 31.0)], first.points)
        assert second.points == first.points
        assert second.replaced_generated == first.generated


class TestBudget:
    def many_blips(self, count: int) -> list[tuple[float, float]]:
        return [(i * 3.0, i * 3.0 + 0.5) for i in range(count)]

    def test_over_the_cap_the_gap_doubles_until_the_points_fit(self) -> None:
        spans = self.many_blips(40)
        fine = plan(spans, duration=200.0)
        assert len(fine.points) == 159 and not fine.coarsened
        coarse = plan(spans, duration=200.0, max_points=100)
        assert coarse.coarsened
        assert len(coarse.points) <= 100
        assert coarse.min_gap_sec > 0.30

    def test_still_over_the_cap_is_a_coded_error(self) -> None:
        with pytest.raises(CodedValueError) as raised:
            plan(self.many_blips(40), duration=200.0, max_points=2)
        assert raised.value.code == "ducking_too_many_points"
        assert "51.2 s" in str(raised.value)
        assert "38.4" not in str(raised.value)

    def test_planning_many_regions_with_a_dense_base_is_fast(self) -> None:
        import time as clock

        spans = [(i * 4.0, i * 4.0 + 1.5) for i in range(2500)]
        base = [EnvPoint(f"b{i}", i * 33.0, 0.4 + (i % 5) * 0.1) for i in range(300)]
        started = clock.perf_counter()
        result = plan(spans, base, duration=10000.0)
        assert clock.perf_counter() - started < 2.0
        assert result.generated > 0


def random_case(seed: int):
    rng = random.Random(seed)
    duration = rng.uniform(5.0, 120.0)
    spans = []
    cursor = rng.uniform(0.0, 3.0)
    while cursor < duration:
        length = rng.uniform(0.0, 4.0)
        spans.append((cursor, cursor + length))
        cursor += length + rng.uniform(0.0, 6.0)
    p = DuckingParams(
        depth_db=rng.choice([-40.0, -18.0, -6.0, -1.0]),
        attack_sec=rng.uniform(0.05, 1.0),
        hold_sec=rng.uniform(0.0, 1.0),
        release_sec=rng.uniform(0.05, 2.0),
        min_gap_sec=rng.uniform(0.0, 1.0),
        min_speech_sec=rng.uniform(0.0, 0.5),
    )
    base: list[EnvPoint] = []
    time = 0.0
    for index in range(rng.randrange(0, 12)):
        time += rng.uniform(0.01, duration / 6)
        base.append(EnvPoint(f"u{index}", time, rng.uniform(0.0, 1.4)))
    return spans, p, base, duration


SEEDS = range(60)


@pytest.mark.parametrize("seed", SEEDS)
def test_properties_over_random_inputs(seed: int) -> None:
    spans, p, base, duration = random_case(seed)
    result = plan_envelope(spans, base, p, duration, ENVELOPE_POINTS_MAX)
    points = result.points
    gain = p.gain
    if not result.regions:
        assert points == base
        return

    for point in points:
        if point.id.startswith(GENERATED_PREFIX) or point.time <= duration:
            assert point.value <= at(base, point.time) + 1e-9
            assert point.value >= min(gain, at(base, point.time)) - 1e-9
    assert [p.time for p in points] == sorted({p.time for p in points})
    generated = [p for p in points if p.id.startswith(GENERATED_PREFIX)]
    assert all(0.0 <= p.time <= duration for p in generated)
    assert len(points) <= ENVELOPE_POINTS_MAX
    assert len({p.id for p in points}) == len(points)

    kept = {p.id for p in points if not p.id.startswith(GENERATED_PREFIX)}
    for original in base:
        assert original.id in kept or any(
            i.startswith(f"{BASE_PREFIX}{original.id}:") for i in kept
        )

    again = plan_envelope(spans, points, p, duration, ENVELOPE_POINTS_MAX)
    assert again.points == points

    poly = duck_polyline(result.regions, p, duration)
    for step in range(0, int(duration * 20)):
        time = step / 20.0
        exact = min(at(base, time), poly_at(poly, time))
        assert at(points, time) <= at(base, time) + 2e-3
        assert at(points, time) >= exact - 2e-3
        if all(b.value <= 1.0 for b in base):
            assert at(points, time) == pytest.approx(exact, abs=2e-3)


@pytest.mark.parametrize("seed", SEEDS)
def test_ramps_are_monotone_and_alternate(seed: int) -> None:
    spans, p, _, duration = random_case(seed)
    points = plan_envelope(spans, [], p, duration, ENVELOPE_POINTS_MAX).points
    steps = [b.value - a.value for a, b in itertools.pairwise(points)]
    signs = [1 if s > 1e-12 else -1 for s in steps if abs(s) > 1e-12]
    assert all(a != b for a, b in itertools.pairwise(signs))
    assert all(p.gain - 1e-12 <= v.value <= 1.0 + 1e-12 for v in points)


@pytest.mark.parametrize("seed", SEEDS)
def test_a_rerun_with_another_depth_equals_a_fresh_run(seed: int) -> None:
    spans, p, base, duration = random_case(seed)
    first = plan_envelope(spans, base, p, duration, ENVELOPE_POINTS_MAX)
    other = replace(p, depth_db=-9.0)
    rerun = plan_envelope(spans, first.points, other, duration, ENVELOPE_POINTS_MAX)
    fresh = plan_envelope(spans, base, other, duration, ENVELOPE_POINTS_MAX)
    assert rerun.points == fresh.points


def make_project(tmp_path: Path, *, with_segments: bool = False) -> EpisodeProject:
    project = EpisodeProject.create("duck", str(tmp_path / "ws"))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=60.0),
        ),
        Track(
            id="music",
            label="Music",
            role=TrackRole.MUSIC,
            media=MediaAsset(path="raw/music.wav", duration_sec=60.0),
        ),
    ]
    project.timeline.duration_sec = 60.0
    project.timeline.clips = [
        Clip(id="h1", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0),
        Clip(id="h2", track_id="host", source_start=20.0, source_end=40.0, timeline_start=10.0),
    ]
    words = [
        TranscriptWord(text="a", start=2.0, end=3.0),
        TranscriptWord(text="cut", start=12.0, end=13.0),
        TranscriptWord(text="b", start=22.0, end=23.0),
        TranscriptWord(text="ignored", start=24.0, end=25.0, ignored=True),
        TranscriptWord(text="suspect", start=26.0, end=27.0, suspect_hallucination=True),
        TranscriptWord(text="bleed", start=28.0, end=29.0, suppressed=True),
        TranscriptWord(text="muted", start=30.2, end=30.8),
        TranscriptWord(text="off", start=34.2, end=34.8),
        TranscriptWord(text="c", start=36.0, end=37.0),
    ]
    project.transcripts = [Transcript(track_id="host", words=words)]
    project.timeline.clips[1].mute_regions = [ClipMuteRegion(start_s=30.0, end_s=31.0)]
    project.timeline.clips[1].off_speaker_mute_regions = [
        ClipOffSpeakerMuteRegion(start_s=34.0, end_s=35.0)
    ]
    return project


class TestActivity:
    def test_words_land_where_the_timeline_plays_them_after_a_ripple(self, tmp_path) -> None:
        project = make_project(tmp_path)
        spans = dialogue_activity(project, ["host"])
        assert spans == [(2.0, 3.0), (12.0, 13.0), (26.0, 27.0)]

    def test_a_moved_clip_moves_its_activity(self, tmp_path) -> None:
        project = make_project(tmp_path)
        project.timeline.clips[1].timeline_start = 15.0
        assert dialogue_activity(project, ["host"]) == [(2.0, 3.0), (17.0, 18.0), (31.0, 32.0)]

    def test_ignored_suspect_suppressed_and_muted_words_do_not_count(self, tmp_path) -> None:
        project = make_project(tmp_path)
        covered = dialogue_activity(project, ["host"])
        for lost in [(14.0, 15.0), (16.0, 17.0), (18.0, 19.0), (20.2, 20.8), (24.2, 24.8)]:
            assert not any(s < lost[1] and e > lost[0] for s, e in covered)

    def test_a_lowered_mute_still_plays_so_it_still_ducks(self, tmp_path) -> None:
        project = make_project(tmp_path)
        project.timeline.clips[1].mute_regions = [
            ClipMuteRegion(start_s=30.0, end_s=31.0, gain_db=-12.0)
        ]
        assert any(s <= 20.2 and e >= 20.8 for s, e in dialogue_activity(project, ["host"]))

    def test_a_muted_dialogue_track_is_not_a_source(self, tmp_path) -> None:
        project = make_project(tmp_path)
        project.timeline.tracks[0].muted = True
        assert dialogue_sources(project, None) == []
        assert dialogue_sources(project, ["host"]) == ["host"]

    def test_a_non_dialogue_source_is_refused(self, tmp_path) -> None:
        project = make_project(tmp_path)
        with pytest.raises(CodedValueError) as raised:
            dialogue_sources(project, ["music"])
        assert raised.value.code == "ducking_not_dialogue"
        with pytest.raises(CodedValueError) as raised:
            dialogue_sources(project, ["nobody"])
        assert raised.value.code == "ducking_unknown_track"


class FakeStore:
    def __init__(self, ducking: dict[tuple[str, int], bool]) -> None:
        self.ducking = ducking

    def get(self, segment_id: str, version: int):
        if (segment_id, version) not in self.ducking:
            raise CodedValueError("unknown segment", code="segment_unknown")
        return SimpleNamespace(duck_under_dialogue=self.ducking[(segment_id, version)])


def ref(segment_id: str, version: int = 1) -> SegmentRef:
    return SegmentRef(segment_id=segment_id, version=version, content_sha256="0" * 64)


class TestTargets:
    def test_default_targets_are_unmuted_music_with_media(self, tmp_path) -> None:
        project = make_project(tmp_path)
        project.timeline.tracks += [
            Track(id="m2", label="M2", role=TrackRole.MUSIC, media=MediaAsset(path="raw/m2.wav")),
            Track(
                id="muted",
                label="Q",
                role=TrackRole.MUSIC,
                media=MediaAsset(path="x.wav"),
                muted=True,
            ),
            Track(id="empty", label="E", role=TrackRole.MUSIC),
            Track(id="intro", label="I", role=TrackRole.INTRO, media=MediaAsset(path="i.wav")),
            Track(id="sfx", label="S", role=TrackRole.SFX, media=MediaAsset(path="s.wav")),
        ]
        assert select_targets(project, None, []) == ["music", "m2"]

    def test_named_tracks_override_and_may_be_intro_or_sfx(self, tmp_path) -> None:
        project = make_project(tmp_path)
        project.timeline.tracks.append(Track(id="intro", label="I", role=TrackRole.INTRO))
        assert select_targets(project, ["intro", "intro"], []) == ["intro"]

    def test_a_dialogue_or_unknown_target_is_refused(self, tmp_path) -> None:
        project = make_project(tmp_path)
        with pytest.raises(CodedValueError) as raised:
            select_targets(project, ["host"], [])
        assert raised.value.code == "ducking_dialogue_target"
        with pytest.raises(CodedValueError) as raised:
            select_targets(project, ["nobody"], [])
        assert raised.value.code == "ducking_unknown_track"

    def test_no_music_and_no_segment_is_an_error_not_an_empty_plan(self, tmp_path) -> None:
        project = make_project(tmp_path)
        project.timeline.tracks[1].muted = True
        with pytest.raises(CodedValueError) as raised:
            select_targets(project, None, [])
        assert raised.value.code == "ducking_no_targets"

    def test_a_segment_marked_duck_under_dialogue_adds_its_track(self, tmp_path) -> None:
        project = make_project(tmp_path)
        project.timeline.tracks += [
            Track(id="sting", label="Sting", role=TrackRole.SFX),
            Track(id="plain", label="Plain", role=TrackRole.SFX),
            Track(id="gone", label="Gone", role=TrackRole.SFX),
        ]
        project.timeline.clips += [
            Clip(
                id="s1",
                track_id="sting",
                source_start=0,
                source_end=3,
                timeline_start=5,
                segment_ref=ref("duck"),
            ),
            Clip(
                id="s2",
                track_id="plain",
                source_start=0,
                source_end=3,
                timeline_start=5,
                segment_ref=ref("plain"),
            ),
            Clip(
                id="s3",
                track_id="gone",
                source_start=0,
                source_end=3,
                timeline_start=5,
                segment_ref=ref("missing"),
            ),
        ]
        warnings: list[str] = []
        store = FakeStore({("duck", 1): True, ("plain", 1): False})
        assert select_targets(project, None, warnings, store) == ["music", "sting"]
        assert len(warnings) == 1 and "missing" in warnings[0]


def write_project(tmp_path: Path) -> Path:
    project = make_project(tmp_path)
    project.timeline.tracks.append(
        Track(
            id="music2", label="Music 2", role=TrackRole.MUSIC, media=MediaAsset(path="raw/m2.wav")
        )
    )
    project.timeline.clips = [
        Clip(id="h1", track_id="host", source_start=0.0, source_end=60.0, timeline_start=0.0)
    ]
    project.timeline.clips[0].mute_regions = []
    project.timeline.clips[0].off_speaker_mute_regions = []
    project.transcripts = [
        Transcript(
            track_id="host",
            words=[
                TranscriptWord(text="one", start=2.0, end=3.0),
                TranscriptWord(text="two", start=20.0, end=21.0),
                TranscriptWord(text="three", start=40.0, end=41.0),
            ],
        )
    ]
    project.automation_envelopes = [
        AutomationEnvelope(
            track_id="music",
            points=[
                AutomationPoint(id="f0", time=0.0, value=0.0),
                AutomationPoint(id="f1", time=2.0, value=1.0),
                AutomationPoint(id="f2", time=55.0, value=1.0),
                AutomationPoint(id="f3", time=60.0, value=0.0),
            ],
        )
    ]
    return save_project(project, tmp_path / "ws" / "episode.sharecut")


def envelopes(path: Path) -> dict[str, list[tuple[str, float, float]]]:
    project = load_project(path)
    return {
        e.track_id: [(p.id, p.time, p.value) for p in e.points]
        for e in project.automation_envelopes
        if e.is_volume
    }


def entries(path: Path) -> int:
    return len(HistoryService(ProjectWorkspace.open(path)).list_entries().entries)


@pytest.fixture
def duck_project(tmp_path: Path) -> Path:
    return write_project(tmp_path)


def duck(path: Path, **payload):
    return submit_host_command_result(str(path), "ApplyDucking", payload)


class TestCommand:
    def test_one_apply_is_one_history_entry_and_one_undo_for_every_track(
        self, duck_project
    ) -> None:
        before = envelopes(duck_project)
        result = duck(duck_project)
        assert result["applied"] is True and result["depth_db"] == DEPTH
        assert [t["track_id"] for t in result["tracks"]] == ["music", "music2"]
        after = envelopes(duck_project)
        assert set(after) == {"music", "music2"}
        assert any(i.startswith(GENERATED_PREFIX) for i, _, _ in after["music2"])
        assert (
            HistoryService(ProjectWorkspace.open(duck_project)).list_entries().entries[-1].operation
            == "apply_ducking"
        )

        head = HistoryService(ProjectWorkspace.open(duck_project)).list_entries().head_id
        submit_host_command_result(str(duck_project), "UndoHistory", {"expected_head_id": head})
        assert envelopes(duck_project) == before

    def test_each_apply_adds_exactly_one_history_entry(self, duck_project) -> None:
        duck(duck_project)
        count = entries(duck_project)
        duck(duck_project, depth_db=-9.0)
        assert entries(duck_project) == count + 1

    def test_the_fade_is_kept_and_only_lowered_under_speech(self, duck_project) -> None:
        duck(duck_project)
        points = {i: (t, v) for i, t, v in envelopes(duck_project)["music"]}
        assert points["f0"] == (0.0, 0.0)
        assert points["f3"] == (60.0, 0.0)
        assert points["f2"] == (55.0, 1.0)
        lowered = {i for i in points if i.startswith(BASE_PREFIX)}
        assert len(lowered) == 1
        assert next(iter(lowered)).startswith(f"{BASE_PREFIX}f1:1.0:")

    def test_a_rerun_changes_nothing_and_makes_no_history_entry(self, duck_project) -> None:
        duck(duck_project)
        saved = envelopes(duck_project)
        count = entries(duck_project)
        again = duck(duck_project)
        assert again["applied"] is False
        assert envelopes(duck_project) == saved
        assert entries(duck_project) == count

    def test_a_dry_run_writes_nothing_and_returns_the_plan(self, duck_project) -> None:
        before = envelopes(duck_project)
        count = entries(duck_project)
        seq = DocumentSyncService.open(duck_project).document_snapshot()["server_seq"]
        result = duck(duck_project, dry_run=True)
        assert result["dry_run"] is True and result["applied"] is False
        assert result["plan_token"]
        assert result["tracks"][0]["envelope"] and result["tracks"][0]["speech_regions"]
        assert envelopes(duck_project) == before
        assert entries(duck_project) == count
        assert DocumentSyncService.open(duck_project).document_snapshot()["server_seq"] == seq

    def test_the_planned_token_applies_and_a_changed_project_refuses_it(self, duck_project) -> None:
        token = duck(duck_project, dry_run=True)["plan_token"]
        assert duck(duck_project, expected_plan_token=token)["applied"] is True

        fresh = duck_project.parent / "other"
        stale_path = write_project(fresh)
        stale_token = duck(stale_path, dry_run=True)["plan_token"]
        project = load_project(stale_path)
        project.transcripts[0].words.append(TranscriptWord(text="new", start=45.0, end=46.0))
        save_project(project, stale_path)
        before = envelopes(stale_path)
        count = entries(stale_path)
        with pytest.raises(DocumentConflictError, match="changed since"):
            duck(stale_path, expected_plan_token=stale_token)
        assert envelopes(stale_path) == before
        assert entries(stale_path) == count

    def test_a_dialogue_target_is_refused_and_nothing_is_written(self, duck_project) -> None:
        count = entries(duck_project)
        with pytest.raises(CodedValueError) as raised:
            duck(duck_project, track_ids=["host"])
        assert raised.value.code == "ducking_dialogue_target"
        assert entries(duck_project) == count

    def test_a_project_without_a_transcript_is_refused(self, duck_project) -> None:
        project = load_project(duck_project)
        project.transcripts = []
        save_project(project, duck_project)
        with pytest.raises(CodedValueError) as raised:
            duck(duck_project)
        assert raised.value.code == "ducking_no_dialogue_activity"

    def test_the_default_depth_is_the_project_setting_and_a_payload_overrides_it(
        self, duck_project
    ) -> None:
        assert duck(duck_project, dry_run=True)["depth_db"] == DEPTH
        result = duck(duck_project, dry_run=True, depth_db=-30.0)
        floor = min(p["value"] for p in result["tracks"][1]["envelope"])
        assert floor == pytest.approx(math.pow(10.0, -30.0 / 20.0))

    def test_named_tracks_limit_the_write(self, duck_project) -> None:
        duck(duck_project, track_ids=["music2"])
        assert set(envelopes(duck_project)) == {"music", "music2"}
        assert all(
            not i.startswith(GENERATED_PREFIX) for i, _, _ in envelopes(duck_project)["music"]
        )

    def test_the_stems_go_stale_with_the_envelope_reason(self) -> None:
        assert reason_for_operation("apply_ducking") == "envelope"

    def test_the_payload_refuses_unknown_fields_and_out_of_range_numbers(self) -> None:
        with pytest.raises(ValueError):
            validate_payload("ApplyDucking", {"threshold": -40})
        with pytest.raises(ValueError):
            validate_payload("ApplyDucking", {"depth_db": 3.0})
        with pytest.raises(ValueError):
            validate_payload("ApplyDucking", {"release_sec": 11.0})
        assert validate_payload("ApplyDucking", {})["depth_db"] is None

    def test_the_command_is_host_only(self) -> None:
        from podcast_mcp.services.document_sync.registry import COMMANDS

        spec = COMMANDS["ApplyDucking"]
        assert spec.guest is None and spec.host_only_reason

    def test_plan_ducking_reads_the_depth_from_the_config(self, duck_project) -> None:
        project = load_project(duck_project)
        payload = validate_payload("ApplyDucking", {})
        plans = plan_ducking(project, payload, {"mix": {"music_under_vo_db": -10.0}})
        assert plans.depth_db == -10.0


class TestSurfaces:
    def test_the_cli_dry_run_then_apply_and_undo(self, duck_project) -> None:
        dry = runner.invoke(app, ["edit", "duck", "--project", str(duck_project), "--dry-run"])
        assert dry.exit_code == 0, dry.output
        planned = json.loads(dry.output)
        assert planned["dry_run"] is True
        stale = runner.invoke(
            app,
            [
                "edit",
                "duck",
                "--project",
                str(duck_project),
                "--track",
                "music",
                "--depth-db",
                "-12",
                "--plan-token",
                planned["plan_token"],
            ],
        )
        assert stale.exit_code != 0
        result = runner.invoke(
            app,
            [
                "edit",
                "duck",
                "--project",
                str(duck_project),
                "--track",
                "music",
                "--depth-db",
                "-12",
            ],
        )
        assert result.exit_code == 0, result.output
        out = json.loads(result.output)
        assert out["applied"] is True and out["depth_db"] == -12.0
        assert [t["track_id"] for t in out["tracks"]] == ["music"]

    def test_the_cli_reports_a_refusal(self, duck_project) -> None:
        result = runner.invoke(
            app, ["edit", "duck", "--project", str(duck_project), "--track", "host"]
        )
        assert result.exit_code != 0
        assert "ducking_dialogue_target" in result.output

    def test_the_generic_submit_reaches_the_command(self, duck_project) -> None:
        result = runner.invoke(
            app,
            [
                "doc",
                "submit",
                "ApplyDucking",
                "--project",
                str(duck_project),
                "--payload",
                '{"dry_run": true}',
            ],
        )
        assert result.exit_code == 0, result.output
        assert json.loads(result.output)["result"]["dry_run"] is True

    def test_the_mcp_tool_returns_the_plan_on_a_dry_run(self, duck_project) -> None:
        dry = json.loads(mcp_server.apply_ducking_tool(str(duck_project), dry_run=True))
        assert dry["dry_run"] is True
        assert dry["tracks"][0]["envelope"] and dry["tracks"][0]["speech_regions"]
        applied = json.loads(
            mcp_server.apply_ducking_tool(
                str(duck_project), track_ids=["music2"], expected_plan_token=None, depth_db=-12.0
            )
        )
        assert applied["applied"] is True
        assert applied["tracks"][0]["generated"] > 0
        assert any(i.startswith(GENERATED_PREFIX) for i, _, _ in envelopes(duck_project)["music2"])

    def test_the_mcp_tool_raises_the_coded_refusal(self, duck_project) -> None:
        with pytest.raises(CodedValueError) as raised:
            mcp_server.apply_ducking_tool(str(duck_project), track_ids=["host"])
        assert raised.value.code == "ducking_dialogue_target"


def test_mix_with_music_still_replaces_the_envelope(
    minimal_project, sample_wav, tmp_workspace
) -> None:
    """Slice 8 owns merging ducking into mix_with_music; until then a pipeline run erases it."""
    from podcast_mcp.config.defaults import load_defaults
    from podcast_mcp.engines.ffmpeg import FFmpegEngine
    from podcast_mcp.pipeline import steps
    from test_pipeline_steps_extended import _dialogue_project

    if not FFmpegEngine().check_available()[0]:
        pytest.skip("ffmpeg not available")
    project = _dialogue_project(minimal_project, sample_wav, tmp_workspace)
    defaults = load_defaults()
    steps.ingest_tracks(project, defaults)
    steps.assemble_timeline(project, defaults)
    steps.mix_with_music(project, defaults)
    envelope = project.volume_envelope_for("bed")
    assert envelope is not None
    envelope.points.append(AutomationPoint(id=generated_point_id(0.5, 0.25), time=0.5, value=0.25))
    steps.mix_with_music(project, defaults)
    rebuilt = project.volume_envelope_for("bed")
    assert rebuilt is not None
    assert len(rebuilt.points) == 4
    assert not any(p.id.startswith("duck:") for p in rebuilt.points)


def test_set_envelopes_refuses_a_missing_track_before_writing_any(envelope_project) -> None:
    ws = ProjectWorkspace.open(envelope_project)
    good = [{"id": "a", "time": 1.0, "value": 0.5}]
    with pytest.raises(CodedValueError) as raised:
        PipelineService(ws).set_envelopes({"host": good, "nobody": good})
    assert raised.value.code == "envelope_track_missing"
    assert ProjectWorkspace.open(envelope_project).project.volume_envelope_for("host") is None
