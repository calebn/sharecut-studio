"""The whole-stem fade merged into a track's envelope (pure)."""

from __future__ import annotations

import math
import uuid

import pytest

from podcast_mcp.engines.ducking import (
    BASE_PREFIX,
    DuckingParams,
    EnvPoint,
    generated_point_id,
    plan_envelope,
    restore_base,
)
from podcast_mcp.engines.envelope_fades import (
    FADE_PREFIX,
    SLOTS,
    fade_point_id,
    fade_targets,
    merge_fades,
)
from podcast_mcp.engines.play_audit import envelope_audio_payload
from podcast_mcp.models import AutomationEnvelope, AutomationPoint


def legacy(dur: float, fade_in: float, fade_out: float) -> list[tuple[float, float]]:
    """What the step wrote before the merge: four points, uuid ids."""
    return [(0.0, 0.0), (fade_in, 1.0), (max(fade_in, dur - fade_out), 1.0), (dur, 0.0)]


def tv(points) -> list[tuple[float, float]]:
    return [(p.time, p.value) for p in points]


def fades(points) -> list[EnvPoint]:
    return [p for p in points if p.id.startswith(FADE_PREFIX)]


def merged(points, dur=10.0, fade_in=2.0, fade_out=3.0) -> list[EnvPoint]:
    return merge_fades(points, dur, fade_in, fade_out).points


def lowered(slot: str, time: float, nominal: float, low: float) -> EnvPoint:
    fade_id = fade_point_id(slot, time, nominal)
    return EnvPoint(f"{BASE_PREFIX}{fade_id}:{nominal!r}:{low!r}", time, low)


EXTRAS = {
    "none": [],
    "user": [EnvPoint(str(uuid.uuid4()), 1.0, 0.5), EnvPoint("mine", 6.0, 1.4)],
    "duck_g": [EnvPoint(generated_point_id(0.5, 0.25), 0.5, 0.25)],
    "duck_u": [EnvPoint("duck:u:abc", 4.0, 0.3)],
    "duck_b_other": [EnvPoint(f"{BASE_PREFIX}mine:1.0:0.2", 5.0, 0.2)],
    "duck_b_fade": [lowered("in1", 2.0, 1.0, 0.2)],
}


@pytest.mark.parametrize(
    "dur,fade_in,fade_out",
    [
        (dur, fade_in, fade_out)
        for dur in (1.0, 2.0, 3.5, 10.0, 90.25)
        for fade_in, fade_out in ((2.0, 3.0), (0.5, 0.5), (4.0, 4.0))
        if fade_in <= dur
    ],
)
def test_an_empty_envelope_gets_the_legacy_shape_and_hash(dur, fade_in, fade_out) -> None:
    result = merge_fades([], dur, fade_in, fade_out).points
    assert tv(result) == legacy(dur, fade_in, fade_out)
    new = AutomationEnvelope(
        track_id="t", points=[AutomationPoint(id=p.id, time=p.time, value=p.value) for p in result]
    )
    old = AutomationEnvelope(
        track_id="t",
        points=[
            AutomationPoint(id=str(uuid.uuid4()), time=t, value=v)
            for t, v in legacy(dur, fade_in, fade_out)
        ],
    )
    assert envelope_audio_payload(new) == envelope_audio_payload(old)


@pytest.mark.parametrize("name", EXTRAS)
def test_a_second_run_changes_nothing(name) -> None:
    once = merged(EXTRAS[name])
    assert merged(once) == once
    assert merged(merged(once)) == once


@pytest.mark.parametrize("name", EXTRAS)
def test_extras_stay_verbatim_and_fade_slots_stay_four(name) -> None:
    result = merged(EXTRAS[name])
    for extra in EXTRAS[name]:
        assert extra in result
    assert len(result) == 4 + len(EXTRAS[name]) - (1 if name == "duck_b_fade" else 0)
    assert len({p.id for p in result}) == len(result)
    assert [p.time for p in result] == sorted(p.time for p in result)


def test_a_lowered_fade_point_is_kept_while_the_stem_is_unchanged() -> None:
    result = merged(EXTRAS["duck_b_fade"])
    assert EXTRAS["duck_b_fade"][0] in result
    assert sum(1 for p in result if "mix:fade:in1" in p.id) == 1
    assert merge_fades(EXTRAS["duck_b_fade"], 10.0, 2.0, 3.0).replaced_under_duck == 0


@pytest.mark.parametrize("name", EXTRAS)
def test_a_new_duration_moves_the_fade_and_leaves_the_rest(name) -> None:
    first = merged(EXTRAS[name])
    result = merge_fades(first, 20.0, 2.0, 3.0).points
    got = [p.time for p in result if "mix:fade:" in p.id]
    assert got == [t for t, _ in legacy(20.0, 2.0, 3.0)]
    assert not any(
        p.id.startswith(BASE_PREFIX) and "mix:fade" in p.id and p.time == 7.0 for p in result
    )
    for extra in EXTRAS[name]:
        assert extra in result
    assert len({p.id for p in result}) == len(result)


def test_replacing_a_fade_point_next_to_a_dip_is_reported() -> None:
    first = merged(EXTRAS["duck_g"])
    assert merge_fades(first, 20.0, 2.0, 3.0).replaced_under_duck == 2
    assert merge_fades(merged([]), 20.0, 2.0, 3.0).replaced_under_duck == 0
    assert merge_fades(merged(EXTRAS["duck_b_fade"]), 20.0, 2.0, 3.0).replaced_under_duck >= 1


def test_a_stem_shorter_than_fade_in_fades_in_over_its_length() -> None:
    result = merged([], dur=1.0, fade_in=2.0, fade_out=3.0)
    assert tv(result) == [(0.0, 0.0), (1.0, 1.0), (1.0, 1.0), (1.0, 0.0)]
    assert [p.time for p in result] == sorted(p.time for p in result)
    short = merged([], dur=3.0, fade_in=2.0, fade_out=3.0)
    assert tv(short) == legacy(3.0, 2.0, 3.0)


@pytest.mark.parametrize("dur", [0.0, -1.0, math.nan, math.inf])
def test_no_usable_duration_writes_no_fade(dur) -> None:
    assert fade_targets(dur, 2.0, 3.0) == []
    extras = EXTRAS["user"]
    assert merge_fades(extras, dur, 2.0, 3.0).points == extras
    assert merge_fades([], dur, 2.0, 3.0).points == []


def test_a_moved_fade_point_is_the_users_and_its_slot_is_not_regenerated() -> None:
    moved = EnvPoint(fade_point_id("in1", 2.0, 1.0), 1.0, 1.0)
    result = merged([moved])
    assert moved in result
    assert not any(
        p.id.startswith("mix:fade:in1:") and p is not moved and p != moved for p in result
    )
    assert len(fades(result)) == 4
    assert merged(result) == result


def test_user_points_inside_and_at_the_ends_keep_their_place() -> None:
    mine = [
        EnvPoint("u0", 0.0, 0.7),
        EnvPoint("u1", 1.0, 0.5),
        EnvPoint("u2", 9.0, 0.5),
        EnvPoint("u3", 10.0, 0.9),
        EnvPoint("u4", 12.0, 0.4),
    ]
    result = merged(mine)
    assert [p for p in result if not p.id.startswith(FADE_PREFIX)] == mine
    times = [p.time for p in result]
    assert times == sorted(times)
    assert result[0].id.startswith("mix:fade:in0:") and result[1].id == "u0"
    assert result[-1].id == "u4" and result[-2].id == "u3"
    assert result[-3].id.startswith("mix:fade:out1:")


def test_a_zero_fade_in_keeps_the_start_step_in_order() -> None:
    result = merged([], dur=10.0, fade_in=0.0, fade_out=3.0)
    assert [p.id.split(":")[2] for p in result] == list(SLOTS)
    assert tv(result) == legacy(10.0, 0.0, 3.0)
    assert merged(result, fade_in=0.0) == result


def test_a_zero_fade_out_keeps_the_end_step_in_order() -> None:
    result = merged([], dur=10.0, fade_in=2.0, fade_out=0.0)
    assert [p.id.split(":")[2] for p in result] == list(SLOTS)
    assert tv(result) == legacy(10.0, 2.0, 0.0)
    assert tv(result)[-2:] == [(10.0, 1.0), (10.0, 0.0)]
    assert merged(result, fade_out=0.0) == result


def test_points_beyond_the_stem_are_kept() -> None:
    beyond = [EnvPoint("late", 30.0, 0.3), EnvPoint(generated_point_id(40.0, 0.1), 40.0, 0.1)]
    result = merged(beyond)
    assert result[-2:] == beyond
    assert merged(result) == result


def test_a_tie_puts_the_users_point_after_the_fade_point() -> None:
    result = merged([EnvPoint("u", 2.0, 0.5)])
    ids = [p.id for p in result if p.time == 2.0]
    assert ids[0].startswith("mix:fade:in1:") and ids[1] == "u"


def _uuid_fade(dur=10.0, fade_in=2.0, fade_out=3.0) -> list[EnvPoint]:
    return [EnvPoint(str(uuid.uuid4()), t, v) for t, v in legacy(dur, fade_in, fade_out)]


def test_the_legacy_uuid_fade_is_adopted_not_duplicated() -> None:
    result = merged(_uuid_fade())
    assert len(result) == 4 and all(p.id.startswith(FADE_PREFIX) for p in result)
    assert tv(result) == legacy(10.0, 2.0, 3.0)
    assert tv(merged(_uuid_fade(dur=12.0))) == legacy(10.0, 2.0, 3.0)


def test_a_four_point_envelope_of_another_shape_is_kept() -> None:
    mine = [
        EnvPoint(str(uuid.uuid4()), t, v)
        for t, v in [(0.0, 0.0), (1.0, 0.5), (5.0, 1.0), (9.0, 0.0)]
    ]
    assert all(p in merged(mine) for p in mine) and len(merged(mine)) == 8
    named = [EnvPoint(f"p{i}", p.time, p.value) for i, p in enumerate(_uuid_fade())]
    assert len(merged(named)) == 8


def test_the_legacy_shape_is_adopted_once() -> None:
    once = merged(_uuid_fade())
    assert merged(once) == once and len(once) == 4


DEPTH = DuckingParams(depth_db=-18.0)


def test_ducking_then_a_merge_then_ducking_keeps_the_dip_and_four_fade_points() -> None:
    spans = [(3.0, 4.0), (7.5, 9.5)]
    points = merged([])
    plan = plan_envelope(spans, points, DEPTH, 10.0, 1000)
    assert merged(plan.points) == plan.points
    for _ in range(5):
        plan = plan_envelope(spans, merged(plan.points), DEPTH, 10.0, 1000)
        assert (
            len(fades(plan.points))
            + sum(1 for p in plan.points if p.id.startswith(BASE_PREFIX) and "mix:fade:" in p.id)
            == 4
        )
    assert merged(plan.points) == plan.points


def test_ducking_over_a_fade_ramp_survives_a_merge_at_the_same_duration() -> None:
    plan = plan_envelope([(0.5, 1.5)], merged([]), DEPTH, 10.0, 1000)
    assert any(p.id.startswith(BASE_PREFIX) for p in plan.points)
    assert merged(plan.points) == plan.points
    base, _ = restore_base(plan.points)
    assert sorted(p.id for p in base if p.id.startswith(FADE_PREFIX)) == sorted(
        p.id for p in merged([])
    )


def test_restore_base_passes_fade_ids_through_untouched() -> None:
    points = merged([])
    restored, dropped = restore_base(points)
    assert restored == points and dropped == 0
    low = [lowered("in1", 2.0, 1.0, 0.2)]
    restored, _ = restore_base(low)
    assert restored == [EnvPoint(fade_point_id("in1", 2.0, 1.0), 2.0, 1.0)]
