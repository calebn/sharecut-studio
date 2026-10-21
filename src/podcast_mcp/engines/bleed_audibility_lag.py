"""Per-segment copy lag for word audibility (#1333).

``bleed_lag_segments`` finds where a lane's recorder latency steps; word ownership
must read each bleed source at that stretch's lag, not one steady lag per pair.
"""

from __future__ import annotations

from bisect import bisect_right
from typing import TYPE_CHECKING

import numpy as np

from podcast_mcp.engines.bleed_lag_segments import BleedPair, LagSteps, lag_segments
from podcast_mcp.engines.bleed_latency import DEFAULT_SETTINGS, FRAME_SEC, HOP_SEC
from podcast_mcp.engines.envelope_lag import LEVEL_FLOOR_DB, copy_levels_db
from podcast_mcp.engines.session_timeline import SessionTimeline, clip_timeline_point_to_source
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.dsp import frame_peak_db
from podcast_mcp.util.tracks import dialogue_track_ids

if TYPE_CHECKING:
    from podcast_mcp.engines.audio_audit import TrackRmsCacheSet


def _segment_shift_sec(steps: LagSteps, source_sec: float) -> float:
    starts = [segment.start_sec for segment in steps.segments]
    index = max(0, bisect_right(starts, source_sec) - 1)
    return steps.segments[index].shift_sec


def effective_copy_lag_sec(
    steady_lag_sec: float, steps: LagSteps | None, source_sec: float
) -> float:
    """Lag to read ``source`` at ``source_sec``, including a stepped lane's shift."""
    if steps is None or len(steps.segments) < 2:
        return steady_lag_sec
    base = steps.segments[0].shift_sec
    shift = _segment_shift_sec(steps, source_sec)
    return steady_lag_sec + (base - shift)


def _lane_peak_db(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    frame = round(FRAME_SEC * sample_rate)
    hop = round(HOP_SEC * sample_rate)
    return np.maximum(
        frame_peak_db(samples, frame, hop),
        LEVEL_FLOOR_DB,
    )


def measure_lane_lag_steps(
    project: EpisodeProject, caches: TrackRmsCacheSet, lane_id: str
) -> LagSteps | None:
    """Piecewise latency on ``lane_id`` from every measured bleed path onto it."""
    lane_cache = caches.get(lane_id)
    if lane_cache is None:
        return None
    lane_samples = caches.path_samples(lane_id)
    lane_env = copy_levels_db(lane_samples, sample_rate=lane_cache.sample_rate)
    lane_peak = _lane_peak_db(lane_samples, lane_cache.sample_rate)
    references = {
        tid: cache.profile.path_reference_db
        for tid, cache in caches.caches.items()
        if cache is not None
    }
    pairs: list[BleedPair] = []
    for other_id in dialogue_track_ids(project):
        if other_id == lane_id:
            continue
        path = caches.copy_path(lane_id, other_id)
        if not path.lag_sec:
            continue
        other_cache = caches.get(other_id)
        if other_cache is None:
            continue
        other_env = copy_levels_db(
            caches.path_samples(other_id), sample_rate=other_cache.sample_rate
        )
        gap = references.get(other_id, 0.0) - references.get(lane_id, 0.0)
        pairs.append(
            BleedPair(other_env, lane_talks=True, lag_sec=path.lag_sec, other_over_lane_db=gap)
        )
    if not pairs:
        return None
    return lag_segments(
        lane_env,
        pairs,
        heard=lane_env,
        heard_peak=lane_peak[: lane_env.size],
        deadband_sec=DEFAULT_SETTINGS.deadband_sec,
    )


def lag_steps_for_lane(
    project: EpisodeProject, caches: TrackRmsCacheSet, lane_id: str
) -> LagSteps | None:
    """``LagSteps`` for ``lane_id``, or None when the lane does not step."""
    return measure_lane_lag_steps(project, caches, lane_id)


def copy_lag_at_timeline(
    project: EpisodeProject,
    caches: TrackRmsCacheSet,
    source_id: str,
    bleed_id: str,
    timeline_sec: float,
    *,
    lag_steps: dict[str, LagSteps | None] | None = None,
) -> float:
    """Copy lag for reading ``source_id`` when judging a word on ``bleed_id``."""
    path = caches.copy_path(source_id, bleed_id)
    steady = path.lag_sec
    if not steady:
        return 0.0
    # ``None`` in ``lag_steps`` means "measured, the lane does not step"; only a missing key means
    # "not measured". The cache memoizes either answer, so a lane is measured once per reconcile.
    if lag_steps is not None and source_id in lag_steps:
        steps = lag_steps[source_id]
    else:
        steps = caches.lane_lag_steps(project, source_id)
    st = SessionTimeline(project)
    clips = st.lane_clip_spans(source_id)
    if not clips:
        return steady
    read_tl = timeline_sec + steady
    clip = next(
        (span.clip for span in clips if span.timeline_start <= read_tl < span.timeline_end),
        None,
    )
    if clip is None:
        # The source lane has no audio there (it is shorter than the judged lane, or a cut left
        # a gap), so no lag step applies; reading the first clip would raise outside its span.
        return steady
    source_sec = clip_timeline_point_to_source(clip, read_tl)
    return effective_copy_lag_sec(steady, steps, source_sec)
