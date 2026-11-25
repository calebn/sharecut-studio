"""The whole-stem fade of a music, intro or outro track, merged into its volume envelope.

``mix_with_music`` writes the fade as four points with content-addressed ids
(``mix:fade:<slot>:<hash of time and value>``) and keeps every other point: the user's own
points and the ducking points (``duck:g:``, ``duck:b:``, ``duck:u:``). A fade point whose id
still matches its time and value is the step's to re-place; one the user moved or retyped is
theirs and is left alone. Pure: no project, no ffmpeg.
"""

from __future__ import annotations

import hashlib
import math
import uuid
from collections.abc import Iterable
from typing import NamedTuple

from podcast_mcp.engines.ducking import (
    BASE_PREFIX,
    GENERATED_PREFIX,
    USER_PREFIX,
    EnvPoint,
    parse_lowered,
)

FADE_PREFIX = "mix:fade:"
SLOTS = ("in0", "in1", "out0", "out1")
_ID_HASH_CHARS = 12
_DUCK_PREFIXES = (GENERATED_PREFIX, BASE_PREFIX, USER_PREFIX)
_MANAGED_PREFIXES = (FADE_PREFIX, *_DUCK_PREFIXES)


class FadeMerge(NamedTuple):
    points: list[EnvPoint]
    replaced_under_duck: int
    replaced_legacy: int = 0


def fade_point_id(slot: str, time: float, value: float) -> str:
    digest = hashlib.sha1(f"{time:.6f}|{value:.6f}".encode(), usedforsecurity=False)
    return f"{FADE_PREFIX}{slot}:{digest.hexdigest()[:_ID_HASH_CHARS]}"


def fade_targets(dur: float, fade_in: float, fade_out: float) -> list[tuple[str, float, float]]:
    """The four fade vertices in slot order; none for a stem with no usable duration."""
    if not math.isfinite(dur + fade_in + fade_out) or dur <= 0:
        return []
    fi = min(fade_in, dur)
    return [
        ("in0", 0.0, 0.0),
        ("in1", fi, 1.0),
        ("out0", max(fi, dur - fade_out), 1.0),
        ("out1", dur, 0.0),
    ]


def _fade_slot(point_id: str) -> str | None:
    if not point_id.startswith(FADE_PREFIX):
        return None
    slot = point_id[len(FADE_PREFIX) :].split(":", 1)[0]
    return slot if slot in SLOTS else None


def _fade_view(point: EnvPoint) -> tuple[str, str, float] | None:
    """(slot, original id, original value) when the point is a fade point, lowered or not."""
    slot = _fade_slot(point.id)
    if slot is not None:
        return slot, point.id, point.value
    lowered = parse_lowered(point.id)
    if lowered is not None:
        slot = _fade_slot(lowered[0])
        if slot is not None:
            return slot, lowered[0], lowered[1]
    return None


def _is_uuid(text: str) -> bool:
    try:
        uuid.UUID(text)
    except ValueError:
        return False
    return True


def _legacy_fade_indices(points: list[EnvPoint]) -> set[int]:
    """Indices of the four uuid points an earlier mix run wrote, (0,0) (a,1) (b,1) (c,0).

    Found as a subset, so dip and user points around them do not hide them. Only unprefixed
    uuid ids count; A is the first value-0 point at time 0, D the last value-0 point, and B
    and C the first and last value-1 points between them.
    """
    cand = [
        i for i, p in enumerate(points) if not p.id.startswith(_MANAGED_PREFIXES) and _is_uuid(p.id)
    ]
    starts = [i for i in cand if points[i].time == 0.0 and points[i].value == 0.0]
    ends = [i for i in cand if points[i].value == 0.0]
    if not starts or not ends:
        return set()
    a, d = starts[0], ends[-1]
    if a == d or points[a].time > points[d].time:
        return set()
    ones = [
        i
        for i in cand
        if points[i].value == 1.0 and points[a].time <= points[i].time <= points[d].time
    ]
    ones = [i for i in ones if i not in (a, d)]
    if len(ones) < 2:
        return set()
    b, c = ones[0], ones[-1]
    if not points[a].time <= points[b].time <= points[c].time <= points[d].time:
        return set()
    return {a, b, c, d}


def _has_duck_point(points: Iterable[EnvPoint]) -> bool:
    return any(p.id.startswith(_DUCK_PREFIXES) for p in points)


def merge_fades(
    points: Iterable[EnvPoint], dur: float, fade_in: float, fade_out: float
) -> FadeMerge:
    """The envelope with its whole-stem fade placed for a stem of ``dur`` seconds.

    Unchanged fade points keep their (possibly lowered) form, changed ones are replaced by
    nominal points, and every other point stays as it is. Running it again changes nothing.
    """
    current = list(points)
    targets = fade_targets(dur, fade_in, fade_out)
    if not targets:
        return FadeMerge(current, 0)
    legacy: set[int] = set()
    if not any(p.id.startswith(FADE_PREFIX) for p in current):
        legacy = _legacy_fade_indices(current)
        current = [p for i, p in enumerate(current) if i not in legacy]

    owner: dict[str, int] = {}  # slot -> index of the point that holds it
    for index, point in enumerate(current):
        view = _fade_view(point)
        if view is not None and view[0] not in owner:
            owner[view[0]] = index
    duck_near = _has_duck_point(current)

    wanted = {slot: (time, value) for slot, time, value in targets}
    kept: list[EnvPoint] = []
    satisfied: set[str] = set()
    user_owned: set[str] = set()
    replaced_under_duck = 0
    for index, point in enumerate(current):
        view = _fade_view(point)
        if view is None or owner[view[0]] != index:
            kept.append(point)
            continue
        slot, original_id, original_value = view
        if original_id != fade_point_id(slot, point.time, original_value):
            user_owned.add(slot)
            kept.append(point)
        elif (point.time, original_value) == wanted[slot]:
            satisfied.add(slot)
            kept.append(point)
        elif duck_near:
            replaced_under_duck += 1

    fresh = [
        EnvPoint(fade_point_id(slot, time, value), time, value)
        for slot, time, value in targets
        if slot not in satisfied and slot not in user_owned
    ]

    def order(point: EnvPoint) -> tuple[float, int, int]:
        view = _fade_view(point)
        if view is None:
            return point.time, 1, 0
        return point.time, 0, SLOTS.index(view[0])

    return FadeMerge(sorted(kept + fresh, key=order), replaced_under_duck, len(legacy))
