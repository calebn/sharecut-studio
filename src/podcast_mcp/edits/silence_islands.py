"""Silence-island scan and narrative handoff cut suggestions (timeline clock)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from math import inf, isfinite
from typing import Any

import numpy as np

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines.audio_audit import build_track_rms_caches
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.dsp import DIGITAL_SILENCE_DB, bool_runs


@dataclass(frozen=True)
class SilenceIsland:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    @property
    def midpoint(self) -> float:
        return self.start + self.duration / 2.0

    def to_dict(self) -> dict[str, float]:
        return {
            "start": round(self.start, 4),
            "end": round(self.end, 4),
            "duration": round(self.duration, 4),
            "midpoint": round(self.midpoint, 4),
        }


def silence_islands_from_hops(
    hops: list[tuple[float, float]],
    *,
    min_duration_sec: float = 0.12,
) -> list[SilenceIsland]:
    """Cluster contiguous quiet hops into silence islands.

    ``hops`` are ``(timeline_sec, level_over_floor_db)`` samples (any spacing), as
    :func:`timeline_floor_hops` measures them. A hop is quiet at or under its floor.
    """
    if not hops:
        return []
    ordered = sorted(hops, key=lambda h: h[0])
    quiet = np.asarray([db <= 0.0 for _, db in ordered], dtype=bool)
    return [
        SilenceIsland(start=ordered[start][0], end=ordered[end - 1][0])
        for start, end in bool_runs(quiet)
        if ordered[end - 1][0] - ordered[start][0] >= min_duration_sec
    ]


_MIN_CUT_SEC = 0.05
_MIN_RETAIN_SEC = 0.05


def _island_at(islands: list[SilenceIsland], t: float) -> SilenceIsland | None:
    for island in islands:
        if island.start - 1e-9 <= t <= island.end + 1e-9:
            return island
    return None


def _snap_to_quiet(
    hops: list[tuple[float, float]],
    t: float,
    *,
    lo: float,
    hi: float,
    islands: list[SilenceIsland],
    window_sec: float = 0.12,
) -> float | None:
    """Quietest hop near ``t`` that sits in a silence island, or ``None``.

    A single quiet frame is not enough — um / chair / bleed can dip under the
    floor for a hop without being room tone. Transcript word gaps are
    never consulted. Among equally quiet hops, pick the one closest to ``t``.
    """
    if hi <= lo:
        return None
    t = min(hi, max(lo, t))
    candidates = [
        (ht, db)
        for ht, db in hops
        if lo - 1e-9 <= ht <= hi + 1e-9
        and abs(ht - t) <= window_sec
        and db <= 0.0
        and _island_at(islands, ht) is not None
    ]
    if not candidates:
        return None
    best_db = min(db for _, db in candidates)
    near = [(ht, db) for ht, db in candidates if db <= best_db + 0.5]
    return min(near, key=lambda x: (abs(x[0] - t), x[0]))[0]


def timeline_floor_hops(
    project: EpisodeProject,
    track_ids: Sequence[str],
    timeline_start: float,
    timeline_end: float,
    *,
    hop_ms: int = 20,
    defaults: EffectiveConfig,
) -> list[tuple[float, float]]:
    """Measure, on shared ``hop_ms`` timeline hops, how far the loudest lane is over its floor.

    Each lane is read against its own voice floor (``LevelProfile.voice_floor_db``), so a
    hop is quiet (at or under 0 dB) when no lane holds a voice, at any recording level.
    A hop with no measurement of some lane is ``inf``: missing evidence is never quiet.

    Uses ``TrackRmsCache`` (processed stem when present) so a handoff window is
    one decode, not one FFmpeg spawn per hop.
    """
    if not track_ids:
        raise CodedValueError(
            "at least one dialogue track is required",
            code="track_ids_empty",
        )
    if timeline_end <= timeline_start:
        raise CodedValueError(
            "timeline_end must be after timeline_start. Pick a timeline_end later than timeline_start.",
            code="range_end_before_start",
        )
    hop = max(0.005, hop_ms / 1000.0)
    track_ids = list(dict.fromkeys(track_ids))
    caches = build_track_rms_caches(project, track_ids=track_ids, defaults=defaults)
    out: list[tuple[float, float]] = []
    t = float(timeline_start)
    while t < timeline_end - 1e-9:
        t1 = min(timeline_end, t + hop)
        over = -inf
        for tid in track_ids:
            cache = caches.get(tid)
            if (
                cache is None
                or t < cache.timeline_offset_sec - 1e-9
                or t1 > cache.timeline_offset_sec + cache.samples.size / cache.sample_rate + 1e-9
            ):
                over = inf
                break
            rms = cache.rms_db(t, t1, floor_db=DIGITAL_SILENCE_DB)
            if rms is None or not isfinite(rms):
                over = inf
                break
            over = max(over, rms - cache.profile.voice_floor_db)
        out.append((t, over))
        t = t1
    return out


def suggest_handoff_cut(
    project: EpisodeProject,
    track_ids: Sequence[str],
    keep_left_end: float,
    keep_right_start: float,
    *,
    min_island_sec: float = 0.12,
    hop_ms: int = 20,
    retain_sec: float = 1.0,
    defaults: EffectiveConfig,
) -> dict[str, Any]:
    """Propose silence→silence ripple bounds between two keep anchors.

    Times are **timeline** seconds. ``keep_left_end`` is the end of material to
    retain on the left (e.g. punchline); ``keep_right_start`` is the start of
    material to retain on the right (e.g. closing pivot).

    Targets ``keep_left + retain_sec`` and ``keep_right - retain_sec`` (clamped
    if the gap is shorter), then snaps each bound onto a measured silence
    island (RMS on the stem — not transcript word gaps). A hop is quiet when every
    lane is at or under its own voice floor, so the answer does not move with the
    recording level. Audible non-words (um, chair, bleed) block a join if they sit
    at the retain target; if they sit between the bounds they are removed with the
    ripple. If a bound is still in energy after snap, the suggestion is not ok.
    """
    if keep_right_start <= keep_left_end:
        raise CodedValueError(
            "keep_right_start must be after keep_left_end. Pick a later keep_right_start.",
            code="range_end_before_start",
        )

    track_ids = list(dict.fromkeys(track_ids))
    hops = timeline_floor_hops(
        project,
        track_ids,
        float(keep_left_end),
        float(keep_right_start),
        hop_ms=hop_ms,
        defaults=defaults,
    )
    islands = silence_islands_from_hops(hops, min_duration_sec=min_island_sec)

    warnings: list[str] = []
    cut_start: float | None = None
    cut_end: float | None = None

    gap = keep_right_start - keep_left_end
    max_retain = max(0.0, (gap - _MIN_CUT_SEC) / 2.0)
    retain = min(retain_sec, max_retain)
    if retain < _MIN_RETAIN_SEC:
        warnings.append("keep_gap_too_short")
    else:
        target_out = keep_left_end + retain
        target_in = keep_right_start - retain
        cut_start = _snap_to_quiet(
            hops,
            target_out,
            lo=keep_left_end,
            hi=target_in - _MIN_CUT_SEC,
            islands=islands,
        )
        if cut_start is None:
            warnings.append("cut_start_not_quiet")
        cut_end = _snap_to_quiet(
            hops,
            target_in,
            lo=(cut_start + _MIN_CUT_SEC)
            if cut_start is not None
            else keep_left_end + _MIN_CUT_SEC,
            hi=keep_right_start,
            islands=islands,
        )
        if cut_end is None:
            warnings.append("cut_end_not_quiet")
        elif cut_start is not None and cut_end <= cut_start + 0.02:
            warnings.append("proposed_bounds_too_tight_or_inverted")
            cut_start = None
            cut_end = None

    out_island = None if cut_start is None else _island_at(islands, cut_start)
    in_island = None if cut_end is None else _island_at(islands, cut_end)

    retained_after_left = None if cut_start is None else round(cut_start - keep_left_end, 4)
    retained_before_right = None if cut_end is None else round(keep_right_start - cut_end, 4)
    if retained_after_left is not None and retained_after_left < 0.45:
        warnings.append("retained_air_after_left_short")
    if retained_before_right is not None and retained_before_right < 0.45:
        warnings.append("retained_air_before_right_short")

    ok = (
        cut_start is not None
        and cut_end is not None
        and cut_end > cut_start
        and "proposed_bounds_too_tight_or_inverted" not in warnings
        and "keep_gap_too_short" not in warnings
        and "cut_start_not_quiet" not in warnings
        and "cut_end_not_quiet" not in warnings
    )

    return {
        "track_id": track_ids[0] if len(track_ids) == 1 else None,
        "track_ids": track_ids,
        "timebase": "timeline",
        "keep_left_end": round(keep_left_end, 4),
        "keep_right_start": round(keep_right_start, 4),
        "islands": [i.to_dict() for i in islands],
        "out_island": None if out_island is None else out_island.to_dict(),
        "in_island": None if in_island is None else in_island.to_dict(),
        "cut_start": None if cut_start is None else round(cut_start, 4),
        "cut_end": None if cut_end is None else round(cut_end, 4),
        "retained_air_after_left_sec": retained_after_left,
        "retained_air_before_right_sec": retained_before_right,
        "use_inaudible_opt": False,
        "ok": ok,
        "warnings": warnings,
        "hint": (
            "Ripple-delete [cut_start, cut_end] with use_inaudible_opt=false so "
            "local snap does not pull bounds onto speech; audition the join "
            "before resolving review comments. Prefer existing room tone over "
            "insert_gap unless the user asks for artificial silence."
        ),
    }
