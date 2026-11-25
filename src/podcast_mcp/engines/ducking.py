"""Ducking: volume keyframes that dip a bed under dialogue, computed from transcript activity.

Pure: no I/O, floats in and floats out. Dialogue activity is read from the project's
transcript words projected onto the timeline clock (the clock envelope times use), and the
dip is composed with the track's existing volume envelope as an exact piecewise-linear
minimum, so a fade or a hand-placed point is never raised.

Points the engine writes carry their origin in ``AutomationPoint.id``, which is how a rerun
tells them from the person's own points without a project-format change:

- ``duck:g:<sha1(time|value)>`` is a generated point. It counts as ours only while its time
  and value still hash to its id; a point the person moved or retyped is theirs and survives.
- ``duck:u:<hash>`` is a generated point the person moved or retyped. It stays as a local
  ceiling: it can lower the result at its own time but never anchors the rest of the track.
- ``duck:b:<id>:<value>:<lowered>`` is a person's point the dip lowered to ``<lowered>``. A
  rerun puts back ``<id>`` and ``<value>`` before it recomputes while the point still holds
  ``<lowered>``; a point retyped to another value is the person's and keeps what they typed.
"""

from __future__ import annotations

import hashlib
import itertools
import math
from bisect import bisect_left, bisect_right
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, replace
from typing import NamedTuple

from podcast_mcp.engines.ranges import merge_timeline_ranges, subtract_ranges_from_intervals
from podcast_mcp.engines.session_timeline import SessionTimeline, source_span_on_timeline
from podcast_mcp.models import AutomationPoint, EpisodeProject, TrackRole, TranscriptWord
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.tracks import mixed_dialogue_track_ids

GENERATED_PREFIX = "duck:g:"
BASE_PREFIX = "duck:b:"
USER_PREFIX = "duck:u:"

DEFAULT_ATTACK_SEC = 0.25
DEFAULT_HOLD_SEC = 0.35
DEFAULT_RELEASE_SEC = 0.8
DEFAULT_MIN_GAP_SEC = 0.80
DEFAULT_MIN_SPEECH_SEC = 0.12
MIN_RAMP_SEC = 0.001
MAX_COARSEN_STEPS = 6
TIME_DIGITS = 6
_FLAT_EPS = 1e-9
_ID_HASH_CHARS = 12


class EnvPoint(NamedTuple):
    id: str
    time: float
    value: float


@dataclass(frozen=True)
class DuckingParams:
    depth_db: float
    attack_sec: float = DEFAULT_ATTACK_SEC
    hold_sec: float = DEFAULT_HOLD_SEC
    release_sec: float = DEFAULT_RELEASE_SEC
    min_gap_sec: float = DEFAULT_MIN_GAP_SEC
    min_speech_sec: float = DEFAULT_MIN_SPEECH_SEC

    @property
    def gain(self) -> float:
        return math.pow(10.0, self.depth_db / 20.0)

    def check(self) -> None:
        values = (
            self.depth_db,
            self.attack_sec,
            self.hold_sec,
            self.release_sec,
            self.min_gap_sec,
            self.min_speech_sec,
        )
        if not all(math.isfinite(v) for v in values):
            raise CodedValueError(
                "Ducking settings must be finite numbers.", code="ducking_bad_param"
            )
        if self.depth_db > 0:
            raise CodedValueError("Ducking depth must be 0 dB or lower.", code="ducking_bad_param")
        if (
            min(self.attack_sec, self.hold_sec, self.release_sec) < 0
            or min(self.min_gap_sec, self.min_speech_sec) < 0
        ):
            raise CodedValueError("Ducking times cannot be negative.", code="ducking_bad_param")


@dataclass(frozen=True)
class DuckingPlan:
    points: list[EnvPoint]
    regions: list[tuple[float, float]]
    generated: int
    lowered: int
    replaced_generated: int
    kept_user_points: int
    coarsened: bool
    min_gap_sec: float


def generated_point_id(time: float, value: float) -> str:
    digest = hashlib.sha1(f"{time:.6f}|{value:.6f}".encode(), usedforsecurity=False)
    return GENERATED_PREFIX + digest.hexdigest()[:_ID_HASH_CHARS]


def _lowered_id(original_id: str, original_value: float, lowered_value: float) -> str:
    return f"{BASE_PREFIX}{original_id}:{original_value!r}:{lowered_value!r}"


def _parse_lowered(point_id: str) -> tuple[str, float, float] | None:
    if not point_id.startswith(BASE_PREFIX):
        return None
    rest, sep_low, raw_low = point_id[len(BASE_PREFIX) :].rpartition(":")
    original_id, sep_orig, raw_orig = rest.rpartition(":")
    if not sep_low or not sep_orig or not original_id:
        return None
    try:
        original, lowered = float(raw_orig), float(raw_low)
    except ValueError:
        return None
    return (original_id, original, lowered) if math.isfinite(original + lowered) else None


def restore_base(points: Iterable[AutomationPoint | EnvPoint]) -> tuple[list[EnvPoint], int]:
    """The person's own points, with our generated ones dropped and lowered ones put back.

    Returns the points sorted by time and how many generated points were dropped. A generated
    point whose time or value no longer matches its id was edited by a person, so it stays,
    under an id that a future generated point cannot take. A lowered point retyped by a person
    keeps the typed value.
    """
    kept: list[EnvPoint] = []
    dropped = 0
    for point in points:
        pid, time, value = point.id, point.time, point.value
        if pid.startswith(GENERATED_PREFIX):
            if pid == generated_point_id(time, value):
                dropped += 1
                continue
            kept.append(EnvPoint(USER_PREFIX + pid[len(GENERATED_PREFIX) :], time, value))
            continue
        lowered = _parse_lowered(pid)
        if lowered is not None:
            original_id, original, written = lowered
            restored = original if abs(value - written) <= _FLAT_EPS else value
            kept.append(EnvPoint(original_id, time, restored))
            continue
        kept.append(EnvPoint(pid, time, value))
    kept.sort(key=lambda p: p.time)
    return kept, dropped


def speech_regions(
    spans: Iterable[tuple[float, float]], params: DuckingParams, duration: float
) -> list[tuple[float, float]]:
    """Speech runs on the timeline, short blips dropped, and runs a dip would not separate merged.

    Two runs merge when the music would spend less than ``min_gap_sec`` at full level between
    their dips: the next run's attack starts less than that after the previous release ends.
    """
    floor = max(params.min_speech_sec, MIN_RAMP_SEC)
    clipped = [
        (max(0.0, float(s)), min(float(duration), float(e)))
        for s, e in spans
        if math.isfinite(s) and math.isfinite(e)
    ]
    solid = [(s, e) for s, e in clipped if e - s >= floor]
    runs = merge_timeline_ranges(solid)
    attack = max(params.attack_sec, MIN_RAMP_SEC)
    release = max(params.release_sec, MIN_RAMP_SEC)
    merged: list[tuple[float, float]] = []
    for start, end in runs:
        if merged:
            prev_start, prev_end = merged[-1]
            bridged = start - prev_end <= params.hold_sec
            quiet = (start - attack) - (prev_end + params.hold_sec + release)
            if bridged or quiet < params.min_gap_sec:
                merged[-1] = (prev_start, max(prev_end, end))
                continue
        merged.append((start, end))
    return merged


Polyline = list[tuple[float, float]]


def _q(time: float) -> float:
    return round(time, TIME_DIGITS)


def _interp(poly: Sequence[tuple[float, float]], times: Sequence[float], time: float) -> float:
    index = bisect_right(times, time)
    if index == 0:
        return poly[0][1]
    if index == len(poly):
        return poly[-1][1]
    (t0, v0), (t1, v1) = poly[index - 1], poly[index]
    if t1 <= t0:
        return v1
    return v0 + (v1 - v0) * (time - t0) / (t1 - t0)


def duck_polyline(
    regions: Sequence[tuple[float, float]], params: DuckingParams, duration: float
) -> Polyline:
    """The dip as ``(time, gain)`` breakpoints: unity, ramp to depth, hold, ramp back to unity.

    The ramp down ends on the speech onset, so the first word is never clipped. Ramps cut by
    the timeline edges keep their slope: the edge gets the interpolated value, not a jump.
    """
    if not regions or duration <= 0:
        return []
    gain = params.gain
    attack = max(params.attack_sec, MIN_RAMP_SEC)
    release = max(params.release_sec, MIN_RAMP_SEC)
    raw: Polyline = []
    for start, end in regions:
        raw.extend(
            [
                (_q(start - attack), 1.0),
                (_q(start), gain),
                (_q(end + params.hold_sec), gain),
                (_q(end + params.hold_sec + release), 1.0),
            ]
        )
    ordered: Polyline = []
    for time, value in raw:
        if ordered and time <= ordered[-1][0]:
            if time == ordered[-1][0] and value == ordered[-1][1]:
                continue
            time = _q(ordered[-1][0] + 10**-TIME_DIGITS)
        ordered.append((time, value))
    ordered_times = [t for t, _ in ordered]
    out: Polyline = []
    if ordered[0][0] < 0.0:
        out.append((0.0, _interp(ordered, ordered_times, 0.0)))
    out.extend((t, v) for t, v in ordered if 0.0 <= t <= duration and not (out and out[-1][0] == t))
    if ordered[-1][0] > duration:
        out.append((duration, _interp(ordered, ordered_times, duration)))
    return out


def _base_value(times: Sequence[float], points: Sequence[EnvPoint], time: float) -> float:
    if not points:
        return 1.0
    index = bisect_right(times, time)
    if index == 0:
        return points[0].value
    if index == len(points):
        return points[-1].value
    left, right = points[index - 1], points[index]
    if right.time <= left.time:
        return right.value
    return left.value + (right.value - left.value) * (time - left.time) / (right.time - left.time)


_OPEN = math.inf


def _ceiling_polyline(
    poly: Polyline, base_at: Callable[[float], float]
) -> tuple[Polyline, list[float], list[bool]]:
    """The dip with its unity ends lifted to the bed's own level, and which segments are open.

    A segment between two unity ends is a pause between dips: nothing caps the bed there, so a
    boost above unity survives. A unity end sits at ``max(1, bed)``, so a ramp starts from the
    bed's level rather than from a step down to unity.
    """
    lifted = [(t, max(1.0, base_at(t)) if v == 1.0 else v) for t, v in poly]
    open_segment = [poly[i][1] == 1.0 and poly[i + 1][1] == 1.0 for i in range(len(poly) - 1)]
    return lifted, [t for t, _ in lifted], open_segment


def _compose(base: Sequence[EnvPoint], poly: Polyline, duration: float) -> list[EnvPoint]:
    anchors = [p for p in base if not p.id.startswith(USER_PREFIX)]
    local = {p.time for p in base if p.id.startswith(USER_PREFIX)}
    anchor_times = [p.time for p in anchors]
    base_times = [p.time for p in base]
    duck_times = [t for t, _ in poly]
    union = sorted(set(base_times) | set(duck_times))

    def base_at(time: float) -> float:
        return _base_value(anchor_times, anchors, time)

    lifted, lifted_times, open_segment = _ceiling_polyline(poly, base_at)

    def duck_at(time: float) -> float:
        index = bisect_left(lifted_times, time)
        if index < len(lifted_times) and lifted_times[index] == time:
            return lifted[index][1]
        if index == 0 or index == len(lifted_times) or open_segment[index - 1]:
            return _OPEN
        return _interp(lifted, lifted_times, time)

    generated_times: set[float] = set()
    for left, right in itertools.pairwise(union):
        ceil_left, ceil_right = duck_at(left), duck_at(right)
        if _OPEN in (ceil_left, ceil_right):
            continue
        gap_left = base_at(left) - ceil_left
        gap_right = base_at(right) - ceil_right
        if (gap_left > _FLAT_EPS and gap_right < -_FLAT_EPS) or (
            gap_left < -_FLAT_EPS and gap_right > _FLAT_EPS
        ):
            crossing = _q(left + (right - left) * gap_left / (gap_left - gap_right))
            if left < crossing < min(right, duration + _FLAT_EPS):
                generated_times.add(crossing)
    existing = set(base_times)
    generated_times |= {t for t in duck_times if t not in existing}

    candidates: list[tuple[float, EnvPoint | None]] = [
        (p.time, p) for p in base if p.time not in generated_times
    ]
    candidates.extend((t, None) for t in generated_times)
    candidates.sort(key=lambda item: item[0])

    cells: list[EnvPoint | None] = []
    for time, point in candidates:
        ceiling = duck_at(time)
        if point is None:
            value = min(base_at(time), ceiling)
            cells.append(EnvPoint(generated_point_id(time, value), time, value))
            continue
        if time in local:
            ceiling = min(ceiling, base_at(time))
        if point.value > ceiling and point.time <= duration:
            cells.append(EnvPoint(_lowered_id(point.id, point.value, ceiling), time, ceiling))
        else:
            cells.append(point)
    return _drop_collinear(cells)


def _drop_collinear(points: Sequence[EnvPoint | None]) -> list[EnvPoint]:
    flat = [p for p in points if p is not None]
    out: list[EnvPoint] = []
    for index, point in enumerate(flat):
        generated = point.id.startswith(GENERATED_PREFIX)
        if generated and 0 < index < len(flat) - 1 and out:
            prev, nxt = out[-1], flat[index + 1]
            if nxt.time > prev.time:
                line = prev.value + (nxt.value - prev.value) * (point.time - prev.time) / (
                    nxt.time - prev.time
                )
                if abs(line - point.value) <= _FLAT_EPS:
                    continue
        out.append(point)
    return out


def _plan_once(
    spans: Sequence[tuple[float, float]],
    base: list[EnvPoint],
    replaced: int,
    params: DuckingParams,
    duration: float,
) -> DuckingPlan:
    regions = speech_regions(spans, params, duration)
    poly = duck_polyline(regions, params, duration)
    points = _compose(base, poly, duration) if poly else list(base)
    generated = sum(1 for p in points if p.id.startswith(GENERATED_PREFIX))
    lowered = sum(1 for p in points if p.id.startswith(BASE_PREFIX))
    return DuckingPlan(
        points=points,
        regions=regions,
        generated=generated,
        lowered=lowered,
        replaced_generated=replaced,
        kept_user_points=len(base),
        coarsened=False,
        min_gap_sec=params.min_gap_sec,
    )


def plan_envelope(
    spans: Sequence[tuple[float, float]],
    current: Iterable[AutomationPoint | EnvPoint],
    params: DuckingParams,
    duration: float,
    max_points: int,
) -> DuckingPlan:
    """The track's volume points with the dip composed in.

    ``spans`` are timeline seconds of dialogue activity. A depth of 0 dB, or no activity, gives
    back the person's own points with an earlier dip removed. A point past the timeline end plays
    nothing, so it is left exactly as saved. Over ``max_points`` the minimum gap
    doubles up to ``MAX_COARSEN_STEPS`` times, then the plan refuses rather than truncate.
    """
    params.check()
    live: list[EnvPoint] = []
    inert: list[EnvPoint] = []
    for point in current:
        beyond = point.time > duration and point.id != generated_point_id(point.time, point.value)
        (inert if beyond else live).append(EnvPoint(point.id, point.time, point.value))
    base, replaced = restore_base(live)
    base = sorted([*base, *inert], key=lambda p: p.time)
    if params.depth_db >= 0:
        return _plan_once([], base, replaced, params, duration)
    gap = params.min_gap_sec
    tried = gap
    for step in range(MAX_COARSEN_STEPS + 1):
        plan = _plan_once(spans, base, replaced, replace(params, min_gap_sec=gap), duration)
        if len(plan.points) <= max_points:
            return replace(plan, coarsened=step > 0)
        tried = gap
        gap = max(gap * 2.0, 0.1)
    raise CodedValueError(
        f"Ducking would write more than {max_points} envelope points even with the dips "
        f"merged across pauses up to {tried:.1f} s. Raise min_gap_sec or hold_sec, or duck a "
        "shorter range.",
        code="ducking_too_many_points",
    )


def plan_token(plans: dict[str, list[EnvPoint]]) -> str:
    digest = hashlib.sha256()
    for track_id in sorted(plans):
        digest.update(f"{track_id}\n".encode())
        for point in plans[track_id]:
            digest.update(f"{point.id}|{point.time!r}|{point.value!r}\n".encode())
    return digest.hexdigest()


def _word_counts_as_speech(word: TranscriptWord) -> bool:
    return not (word.suppressed or word.ignored or word.suspect_hallucination)


def dialogue_activity(
    project: EpisodeProject, track_ids: Sequence[str]
) -> list[tuple[float, float]]:
    """Timeline spans where the named dialogue tracks are audibly speaking, merged and sorted.

    Words are source-clock and go through the clip map, so cuts, ripples and moves are already
    in the timeline's positions. Suppressed, ignored and suspect words are left out, and so are
    the spans a clip mutes in place (a lowered span still plays, so it stays).
    """
    timeline = SessionTimeline(project)
    spans: list[tuple[float, float]] = []
    for track_id in track_ids:
        own: list[tuple[float, float]] = []
        for source_id, transcript in project.selected_source_transcripts(track_id):
            words = [w for w in transcript.words if _word_counts_as_speech(w)]
            if not words:
                continue
            mapped = timeline.map_selected_word_spans(
                track_id, source_id, [(w.start, w.end) for w in words]
            )
            own.extend((float(s), float(e)) for pieces in mapped for s, e in pieces)
        spans.extend(_without_mutes(project, track_id, own))
    return merge_timeline_ranges(sorted(spans))


def _without_mutes(
    project: EpisodeProject, track_id: str, spans: list[tuple[float, float]]
) -> list[tuple[float, float]]:
    muted: list[tuple[float, float]] = []
    for clip in project.clips:
        if clip.track_id != track_id:
            continue
        hard = [r for r in clip.mute_regions if r.gain_db is None]
        for region in [*hard, *clip.off_speaker_mute_regions]:
            lo = max(region.start_s, clip.source_start)
            hi = min(region.end_s, clip.source_end)
            if hi > lo:
                muted.extend(source_span_on_timeline(clip, lo, hi))
    if not muted:
        return spans
    return subtract_ranges_from_intervals(spans, merge_timeline_ranges(sorted(muted)))


def dialogue_sources(project: EpisodeProject, explicit: Sequence[str] | None) -> list[str]:
    """The dialogue tracks whose speech ducks the bed: the named ones, else every mixed one."""
    if explicit is None:
        return mixed_dialogue_track_ids(project)
    out: list[str] = []
    for track_id in explicit:
        track = project.track_by_id(track_id)
        if track is None:
            raise CodedValueError(
                f"Dialogue track {track_id!r} does not exist.", code="ducking_unknown_track"
            )
        if track.role != TrackRole.DIALOGUE:
            raise CodedValueError(
                f"Track {track_id!r} is not a dialogue track, so its audio cannot duck the bed.",
                code="ducking_not_dialogue",
            )
        out.append(track_id)
    return out
