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
    assert merge_fades(first, 20.0, 2.0, 3.0).replaced_under_duck == 0
    assert merge_fades(merged([]), 20.0, 2.0, 3.0).replaced_under_duck == 0
    assert merge_fades(merged(EXTRAS["duck_b_fade"]), 20.0, 2.0, 3.0).replaced_under_duck == 0


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


def _legacy_plus(extra, dur=500.0):
    return sorted([*_uuid_fade(dur, 2.0, 3.0), *extra], key=lambda p: p.time)


def test_a_legacy_fade_beside_dip_points_is_replaced_and_the_dip_kept() -> None:
    dip = [EnvPoint(generated_point_id(100.0, 0.12), 100.0, 0.12)]
    result = merge_fades(_legacy_plus(dip), 600.0, 2.0, 3.0)
    assert result.replaced_legacy == 4
    assert [p for p in result.points if not p.id.startswith(FADE_PREFIX)] == dip
    assert tv(fades(result.points)) == legacy(600.0, 2.0, 3.0)
    assert not any(p.time in (497.0, 500.0) for p in result.points)


@pytest.mark.parametrize(
    "extra",
    [
        [EnvPoint("mine", 50.0, 0.4)],
        [EnvPoint(str(uuid.uuid4()), 50.0, 0.4)],
        [EnvPoint(str(uuid.uuid4()), 30.0, 1.0), EnvPoint(str(uuid.uuid4()), 40.0, 0.0)],
        [EnvPoint(f"{BASE_PREFIX}mine:1.0:0.2", 120.0, 0.2)],
    ],
)
def test_a_legacy_fade_with_user_points_is_not_adopted_and_nothing_is_deleted(extra) -> None:
    old = _legacy_plus(extra)
    result = merge_fades(old, 500.0, 2.0, 3.0)
    assert result.replaced_legacy == 0
    assert all(p in result.points for p in old) and len(result.points) == len(old) + 4


def test_the_exact_four_legacy_case_reports_the_replacement() -> None:
    result = merge_fades(_uuid_fade(), 10.0, 2.0, 3.0)
    assert result.replaced_legacy == 4 and tv(result.points) == legacy(10.0, 2.0, 3.0)


@pytest.mark.parametrize("fade_in,fade_out", [(math.nan, 3.0), (2.0, math.inf)])
def test_a_non_finite_fade_length_leaves_the_envelope_alone(fade_in, fade_out) -> None:
    extras = EXTRAS["user"]
    assert merge_fades(extras, 10.0, fade_in, fade_out).points == extras


def _u(time: float, value: float) -> EnvPoint:
    return EnvPoint(str(uuid.uuid4()), time, value)


@pytest.mark.parametrize(
    "shape",
    [
        [(0.0, 0.0), (2.0, 1.0), (20.0, 1.0), (30.0, 0.0), (32.0, 1.0)],
        [(0.0, 0.0), (2.0, 1.0), (50.0, 0.2), (60.0, 1.0), (120.0, 0.0)],
    ],
)
def test_a_user_envelope_that_is_not_the_fade_geometry_is_untouched(shape) -> None:
    mine = [_u(t, v) for t, v in shape]
    result = merge_fades(mine, 130.0, 2.0, 3.0)
    assert result.replaced_legacy == 0
    assert all(p in result.points for p in mine)
    assert len(result.points) == len(mine) + 4


def test_a_legacy_fade_ducked_on_the_old_stem_is_replaced_and_the_rerun_is_asked_for() -> None:
    old = [_u(t, v) for t, v in legacy(500.0, 2.0, 3.0)]
    lowered_in = EnvPoint(f"{BASE_PREFIX}{old[1].id}:1.0:0.2", 2.0, 0.2)
    lowered_out = EnvPoint(f"{BASE_PREFIX}{old[2].id}:1.0:0.3", 497.0, 0.3)
    dip = EnvPoint(generated_point_id(100.0, 0.12), 100.0, 0.12)
    result = merge_fades([old[0], lowered_in, dip, lowered_out, old[3]], 600.0, 2.0, 3.0)
    assert result.replaced_legacy == 4 and result.replaced_under_duck == 2
    assert [p for p in result.points if not p.id.startswith(FADE_PREFIX)] == [dip]
    assert tv(fades(result.points)) == legacy(600.0, 2.0, 3.0)


@pytest.mark.parametrize("dur", [4.0, 30.0, 500.0])
@pytest.mark.parametrize("fade_in,fade_out", [(1.0, 1.0), (0.0, 3.0), (2.0, 0.0), (0.0, 0.0)])
def test_a_legacy_fade_built_with_the_current_settings_matches_at_any_stem_length(
    dur, fade_in, fade_out
) -> None:
    old = [_u(t, v) for t, v in legacy(dur, fade_in, fade_out)]
    result = merge_fades(old, 77.0, fade_in, fade_out)
    assert result.replaced_legacy == 4 and len(result.points) == 4
    assert merge_fades(result.points, 77.0, fade_in, fade_out).replaced_legacy == 0


def test_a_user_envelope_equal_to_the_old_shape_for_the_current_settings_is_replaced() -> None:
    mine = [_u(t, v) for t, v in legacy(10.0, 2.0, 3.0)]
    result = merge_fades(mine, 10.0, 2.0, 3.0)
    assert result.replaced_legacy == 4 and tv(result.points) == legacy(10.0, 2.0, 3.0)


def test_the_re_run_hint_counts_only_fade_points_near_a_dip() -> None:
    first = merged([EnvPoint(generated_point_id(50.0, 0.12), 50.0, 0.12)], dur=100.0)
    assert merge_fades(first, 100.0, 4.0, 3.0).replaced_under_duck == 0
    assert merge_fades(first, 100.0, 2.0, 6.0).replaced_under_duck == 0
    near = merged([EnvPoint(generated_point_id(98.0, 0.12), 98.0, 0.12)], dur=100.0)
    assert merge_fades(near, 100.0, 2.0, 6.0).replaced_under_duck >= 1
    assert merge_fades(near, 200.0, 2.0, 3.0).replaced_under_duck >= 1
    lowered_point = merged([lowered("out0", 97.0, 1.0, 0.2)], dur=100.0)
    assert merge_fades(lowered_point, 100.0, 2.0, 6.0).replaced_under_duck == 1


@pytest.mark.parametrize(
    "dur,fade_in,fade_out",
    [(0.5, 1.0, 0.0), (0.5, 2.0, 3.0), (1.0, 2.0, 3.0), (1.5, 1.0, 1.0), (0.5, 0.25, 5.0)],
)
def test_a_legacy_fade_for_a_stem_shorter_than_fade_in_is_adopted(dur, fade_in, fade_out) -> None:
    old = [_u(t, v) for t, v in legacy(dur, fade_in, fade_out)]
    result = merge_fades(old, dur, fade_in, fade_out)
    assert result.replaced_legacy == 4
    assert not any(p in result.points for p in old)
    assert len(result.points) == 4
    fi = min(fade_in, dur)
    assert tv(result.points) == [
        (0.0, 0.0),
        (fi, 1.0),
        (max(fi, dur - fade_out), 1.0),
        (dur, 0.0),
    ]
    assert merge_fades(result.points, dur, fade_in, fade_out).points == result.points


def _legacy_shaped(points: list[EnvPoint], fade_in: float, fade_out: float) -> bool:
    """Independent check: exactly four uuid points forming the old shape for some stem end."""
    if len(points) != 4:
        return False
    ends = [p.time for p in points if p.value == 0.0 and p.time > 0]
    if len(ends) != 1:
        return False
    want = sorted(
        [(0.0, 0.0), (fade_in, 1.0), (max(fade_in, ends[0] - fade_out), 1.0), (ends[0], 0.0)]
    )
    return sorted((p.time, p.value) for p in points) == want


def test_user_uuid_envelopes_that_are_not_legacy_shaped_are_never_touched() -> None:
    import random

    rng = random.Random(4529)
    checked = 0
    for _ in range(400):
        fade_in = rng.choice([0.0, 0.5, 1.0, 2.0])
        fade_out = rng.choice([0.0, 1.0, 3.0])
        dur = rng.choice([0.5, 1.0, 4.0, 10.0])
        grid = [0.0, fade_in, max(fade_in, dur - fade_out), dur, dur + 1.0, dur / 2]
        mine = [
            EnvPoint(
                str(uuid.uuid4()),
                rng.choice(grid) if rng.random() < 0.6 else round(rng.uniform(0, 12), 3),
                rng.choice([0.0, 1.0]) if rng.random() < 0.6 else round(rng.uniform(0, 1.5), 3),
            )
            for _ in range(rng.randint(2, 8))
        ]
        if _legacy_shaped(mine, fade_in, fade_out):
            continue
        checked += 1
        result = merge_fades(mine, dur, fade_in, fade_out)
        assert result.replaced_legacy == 0
        assert all(p in result.points for p in mine)
        assert len(result.points) == len(mine) + 4
        assert merge_fades(result.points, dur, fade_in, fade_out).points == result.points
    assert checked > 150


def test_a_user_point_at_the_same_time_as_a_legacy_point_is_not_deleted() -> None:
    user = _u(2.0, 1.0)
    old = _uuid_fade(10.0, 2.0, 3.0)
    result = merge_fades([old[0], user, *old[1:]], 10.0, 2.0, 3.0)
    assert result.replaced_legacy == 0
    assert user in result.points and all(p in result.points for p in old)


def test_points_beyond_the_stem_do_not_pull_in_a_later_end() -> None:
    old = _uuid_fade(10.0, 2.0, 3.0)
    beyond = [_u(12.0, 1.0), _u(15.0, 0.0)]
    result = merge_fades([*old, *beyond], 10.0, 2.0, 3.0)
    assert result.replaced_legacy == 0
    assert all(p in result.points for p in [*old, *beyond])


def test_a_lowered_legacy_point_that_is_swapped_out_asks_for_a_ducking_rerun() -> None:
    old = _uuid_fade(10.0, 2.0, 3.0)
    lowered_b = EnvPoint(f"{BASE_PREFIX}{old[1].id}:1.0:0.2", 2.0, 0.2)
    dips = [EnvPoint(generated_point_id(1.5, 0.12), 1.5, 0.12)]
    result = merge_fades([old[0], *dips, lowered_b, old[2], old[3]], 10.0, 2.0, 3.0)
    assert result.replaced_legacy == 4 and result.replaced_under_duck == 1


def test_a_fade_point_nudged_by_less_than_a_microsecond_is_left_alone() -> None:
    first = merged([])
    nudged = [p._replace(time=p.time + 1e-7) if "in1" in p.id else p for p in first]
    result = merge_fades(nudged, 10.0, 2.0, 3.0)
    assert result.points == nudged and result.replaced_under_duck == 0


def test_a_lowered_managed_fade_point_blocks_adoption() -> None:
    old = _uuid_fade(10.0, 2.0, 3.0)
    managed = lowered("in1", 2.0, 1.0, 0.2)
    result = merge_fades([*old, managed], 10.0, 2.0, 3.0)
    assert result.replaced_legacy == 0 and all(p in result.points for p in old)


def test_only_canonical_uuid_ids_count_as_an_older_fade() -> None:
    odd = [
        EnvPoint(f"{{{uuid.uuid4()}}}" if i == 0 else str(uuid.uuid4()), t, v)
        for i, (t, v) in enumerate(legacy(10.0, 2.0, 3.0))
    ]
    assert merge_fades(odd, 10.0, 2.0, 3.0).replaced_legacy == 0
    nil = [EnvPoint("0" * 32, t, v) for t, v in legacy(10.0, 2.0, 3.0)]
    assert merge_fades(nil, 10.0, 2.0, 3.0).replaced_legacy == 0


def test_adopting_a_plain_legacy_fade_next_to_a_dip_asks_for_a_ducking_rerun() -> None:
    old = _uuid_fade(500.0, 2.0, 3.0)
    dip = EnvPoint(generated_point_id(498.0, 0.126), 498.0, 0.126)
    result = merge_fades([*old, dip], 600.0, 2.0, 3.0)
    assert result.replaced_legacy == 4 and result.replaced_under_duck >= 1
    assert dip in result.points


def test_adopting_a_plain_legacy_fade_with_a_dip_far_from_the_ramps_does_not() -> None:
    old = _uuid_fade(500.0, 2.0, 3.0)
    dip = EnvPoint(generated_point_id(100.0, 0.126), 100.0, 0.126)
    result = merge_fades([*old, dip], 600.0, 2.0, 3.0)
    assert result.replaced_legacy == 4 and result.replaced_under_duck == 0
