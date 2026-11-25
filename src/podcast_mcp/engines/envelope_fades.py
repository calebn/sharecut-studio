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
        return str(uuid.UUID(text)) == text
    except ValueError:
        return False


def _legacy_fade_indices(points: list[EnvPoint], fade_in: float, fade_out: float) -> set[int]:
    """Indices of the four uuid points an earlier mix run wrote, or none.

    Looks only at the base points (a ``duck:b:`` point counts as its original id and value,
    ``duck:g:`` points are ignored). An older fade is adopted only when the base points are
    exactly four uuid points forming (0,0) (fade_in,1) (max(fade_in, end - fade_out),1)
    (end,0) for the settings in force now and some old stem length ``end``; ``end`` may lie
    before fade_in, as an old run wrote for a short stem. Any other base point, or any
    mismatch, adopts nothing, so no point of the user's is ever removed.
    """
    base: list[tuple[int, float, float]] = []
    for index, point in enumerate(points):
        if point.id.startswith(GENERATED_PREFIX):
            continue
        lowered = parse_lowered(point.id)
        if lowered is None:
            base.append((index, point.time, point.value))
            if not _is_uuid(point.id):
                return set()
        else:
            base.append((index, point.time, lowered[1]))
            if not _is_uuid(lowered[0]):
                return set()
    if len(base) != 4:
        return set()
    ends = [t for _, t, v in base if v == 0.0 and t > 0.0]
    if len(ends) != 1:
        return set()
    end = ends[0]
    expected = sorted([(0.0, 0.0), (fade_in, 1.0), (max(fade_in, end - fade_out), 1.0), (end, 0.0)])
    if fade_in < 0.0 or sorted((t, v) for _, t, v in base) != expected:
        return set()
    return {index for index, _, _ in base}


def _near_dip(points: list[EnvPoint], start: float, end: float) -> bool:
    """True when a dip point other than a fade point lies in [start, end]."""
    return any(
        p.id.startswith(_DUCK_PREFIXES) and _fade_view(p) is None and start <= p.time <= end
        for p in points
    )


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
    if not any(_fade_view(p) is not None for p in current):
        legacy = _legacy_fade_indices(current, fade_in, fade_out)
        removed_lowered = sum(1 for i in legacy if current[i].id.startswith(BASE_PREFIX))
        old_ones = [
            (lowered[1] if (lowered := parse_lowered(current[i].id)) else current[i].value, i)
            for i in legacy
        ]
        ramp_times = [current[i].time for v, i in old_ones if v == 1.0]
        current = [p for i, p in enumerate(current) if i not in legacy]
        if legacy and ramp_times and not removed_lowered:
            new_in, new_out = targets[1][1], targets[2][1]
            old_in, old_out = min(ramp_times), max(ramp_times)
            if _near_dip(current, 0.0, max(old_in, new_in)) or _near_dip(
                current, min(old_out, new_out), math.inf
            ):
                removed_lowered += 1

    owner: dict[str, int] = {}  # slot -> index of the point that holds it
    for index, point in enumerate(current):
        view = _fade_view(point)
        if view is not None and view[0] not in owner:
            owner[view[0]] = index

    wanted = {slot: (time, value) for slot, time, value in targets}
    kept: list[EnvPoint] = []
    satisfied: set[str] = set()
    user_owned: set[str] = set()
    replaced_under_duck = removed_lowered if legacy else 0
    for index, point in enumerate(current):
        view = _fade_view(point)
        if view is None or owner[view[0]] != index:
            kept.append(point)
            continue
        slot, original_id, original_value = view
        if original_id != fade_point_id(slot, point.time, original_value):
            user_owned.add(slot)
            kept.append(point)
        elif original_id == fade_point_id(slot, *wanted[slot]):
            satisfied.add(slot)
            kept.append(point)
        elif point.id.startswith(BASE_PREFIX):
            replaced_under_duck += 1
        else:
            target_time = wanted[slot][0]
            lo, hi = (
                (0.0, max(point.time, target_time))
                if slot.startswith("in")
                else (min(point.time, target_time), math.inf)
            )
            if _near_dip(current, lo, hi):
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
