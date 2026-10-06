"""Per-track recording latency solved from the bleed each voice leaves on other mics.

Each track's audio reaches the session clock after its own capture/network latency
``o_t``. A voice ``s`` copied onto mic ``m`` shows up there at ``o_m``; on its own
track at ``o_s``. So the envelope lag of ``s``'s direct track behind its copy on ``m``
measures ``o_s - o_m``. Every measurable ordered pair is one equation; the reference
track is ``o = 0``; weighted least squares gives one latency per track and a residual
per pair. A track shifts only when every pair touching it agrees within tolerance.

Times are seconds on the session clock, at the placement the caller measured.
"""

from __future__ import annotations

import itertools
from dataclasses import asdict, dataclass, replace
from typing import Any, Literal

import numpy as np

from podcast_mcp.engines.envelope_lag import LEVEL_FLOOR_DB, envelope_lag

FRAME_SEC = 0.03
HOP_SEC = 0.005
MAX_LAG_SEC = 0.5
WINDOW_SEC = 30.0
OPEN_DB = -60.0
DOMINANCE_DB = 6.0
MIN_WINDOW_FRAMES = 100
MIN_SUPPORTED_WINDOWS = 5
MIN_INLIER_SHARE = 0.6
# Window lags within this of a pair's median are inliers; a solved pair residual beyond
# it is a conflict; a trend moving more than this across the episode is drift. On the
# lab tape honest windows spread with MAD 8 ms (sigma ~12 ms), so 40 ms keeps them while
# rejecting wrong-syllable peaks (+380..+500 ms). 40 ms is also about where a quiet
# delayed copy stops fusing with the direct sound and starts to read as an echo.
TOLERANCE_SEC = 0.04
# Below this the estimate is inside its own spread; the track counts as aligned.
MIN_SHIFT_SEC = 0.02

PairReason = Literal["consistent", "no_bleed", "scattered", "drifting"]
TrackReason = Literal["reference", "aligned", "shift", "no_bleed_evidence", "conflict", "drifting"]


@dataclass(frozen=True)
class PairLag:
    """How far ``source``'s direct track trails its copy on ``mic`` (negative: it leads)."""

    source_track_id: str
    mic_track_id: str
    lag_sec: float | None
    supported_windows: int
    inlier_windows: int
    spread_sec: float | None
    trend_sec: float | None
    reason: PairReason
    residual_sec: float | None = None


@dataclass(frozen=True)
class TrackLatency:
    """Latency behind the reference; positive means the track plays late."""

    track_id: str
    latency_sec: float | None
    reason: TrackReason


@dataclass(frozen=True)
class LatencySolution:
    reference_track_id: str
    tolerance_sec: float
    pairs: tuple[PairLag, ...]
    tracks: tuple[TrackLatency, ...]

    def track(self, track_id: str) -> TrackLatency | None:
        return next((t for t in self.tracks if t.track_id == track_id), None)

    def to_dict(self) -> dict[str, Any]:
        return {
            "reference_track_id": self.reference_track_id,
            "tolerance_sec": self.tolerance_sec,
            "pairs": [asdict(p) for p in self.pairs],
            "tracks": [asdict(t) for t in self.tracks],
        }


def _theil_sen(times: np.ndarray, values: np.ndarray) -> float:
    slopes = [
        (values[j] - values[i]) / (times[j] - times[i])
        for i, j in itertools.combinations(range(times.size), 2)
        if times[j] != times[i]
    ]
    return float(np.median(slopes)) if slopes else 0.0


def measure_pair(
    source: np.ndarray, mic: np.ndarray, *, source_track_id: str, mic_track_id: str
) -> PairLag:
    """Windowed lag of ``source``'s level envelope behind its copy in ``mic``'s.

    Frames count where the source is open within reach and out-levels the mic by
    ``DOMINANCE_DB``: the source talks and the mic carries only its copy. The
    neighbourhood maximum keeps that mask the same at every candidate lag.
    """
    count = min(source.size, mic.size)
    reach = round(MAX_LAG_SEC / HOP_SEC)
    floor = np.full(reach, LEVEL_FLOOR_DB)
    padded = np.concatenate([floor, source[:count], floor])
    near = np.lib.stride_tricks.sliding_window_view(padded, 2 * reach + 1).max(axis=1)
    mask = (near > OPEN_DB) & (near - mic[:count] >= DOMINANCE_DB)
    step = round(WINDOW_SEC / HOP_SEC)
    rows: list[tuple[float, float]] = []
    for first in range(reach, count - reach, step):
        frames = first + np.flatnonzero(mask[first : min(first + step, count - reach)])
        found = envelope_lag(
            mic, source, frames, reach=reach, hop_sec=HOP_SEC, min_frames=MIN_WINDOW_FRAMES
        )
        if found is not None and found.supported:
            rows.append((first * HOP_SEC, found.lag * HOP_SEC))
    if len(rows) < MIN_SUPPORTED_WINDOWS:
        return PairLag(source_track_id, mic_track_id, None, len(rows), 0, None, None, "no_bleed")
    times, lags = (np.array(column) for column in zip(*rows, strict=True))
    keep = np.abs(lags - np.median(lags)) <= TOLERANCE_SEC
    inliers = int(keep.sum())
    if inliers < MIN_SUPPORTED_WINDOWS or inliers < MIN_INLIER_SHARE * len(rows):
        return PairLag(
            source_track_id, mic_track_id, None, len(rows), inliers, None, None, "scattered"
        )
    lag = float(np.median(lags[keep]))
    spread = float(np.median(np.abs(lags[keep] - lag)))
    trend = _theil_sen(times[keep], lags[keep]) * float(np.ptp(times[keep]))
    return PairLag(
        source_track_id,
        mic_track_id,
        lag,
        len(rows),
        inliers,
        spread,
        trend,
        "drifting" if abs(trend) > TOLERANCE_SEC else "consistent",
    )


def solve_latency(
    pairs: list[PairLag], track_ids: list[str], reference_track_id: str
) -> LatencySolution:
    """Weighted least squares over consistent pairs (weight = inlier windows)."""
    edges = [p for p in pairs if p.reason == "consistent" and p.lag_sec is not None]
    reached = {reference_track_id}
    grew = True
    while grew:
        grew = False
        for p in edges:
            ends = {p.source_track_id, p.mic_track_id}
            if len(ends & reached) == 1:
                reached |= ends
                grew = True
    unknowns = [t for t in track_ids if t in reached and t != reference_track_id]
    used = [p for p in edges if {p.source_track_id, p.mic_track_id} <= reached]
    latency = {reference_track_id: 0.0}
    if unknowns:
        column = {t: i for i, t in enumerate(unknowns)}
        design = np.zeros((len(used), len(unknowns)))
        target = np.zeros(len(used))
        for row, p in enumerate(used):
            weight = np.sqrt(p.inlier_windows)
            if p.source_track_id in column:
                design[row, column[p.source_track_id]] = weight
            if p.mic_track_id in column:
                design[row, column[p.mic_track_id]] = -weight
            target[row] = weight * float(p.lag_sec or 0.0)
        solved = np.linalg.lstsq(design, target, rcond=None)[0]
        latency.update({t: float(solved[i]) for t, i in column.items()})
    residual = {
        id(p): float(p.lag_sec or 0.0) - (latency[p.source_track_id] - latency[p.mic_track_id])
        for p in used
    }
    conflicted = {
        t
        for p in used
        if abs(residual[id(p)]) > TOLERANCE_SEC
        for t in (p.source_track_id, p.mic_track_id)
    }
    drifting = {
        t for p in pairs if p.reason == "drifting" for t in (p.source_track_id, p.mic_track_id)
    }
    tracks: list[TrackLatency] = []
    for track_id in track_ids:
        value = latency.get(track_id)
        if track_id == reference_track_id:
            reason: TrackReason = "conflict" if track_id in conflicted else "reference"
        elif value is None:
            reason = "drifting" if track_id in drifting else "no_bleed_evidence"
        elif track_id in conflicted:
            reason = "conflict"
        else:
            reason = "shift" if abs(value) >= MIN_SHIFT_SEC else "aligned"
        tracks.append(TrackLatency(track_id, value, reason))
    return LatencySolution(
        reference_track_id,
        TOLERANCE_SEC,
        tuple(replace(p, residual_sec=residual.get(id(p))) for p in pairs),
        tuple(tracks),
    )


def measure_bleed_latency(
    levels: dict[str, np.ndarray], reference_track_id: str
) -> LatencySolution:
    """Every ordered pair of level envelopes (``HOP_SEC`` grid), then the per-track solve."""
    track_ids = list(levels)
    pairs = [
        measure_pair(levels[s], levels[m], source_track_id=s, mic_track_id=m)
        for s, m in itertools.permutations(track_ids, 2)
    ]
    return solve_latency(pairs, track_ids, reference_track_id)
