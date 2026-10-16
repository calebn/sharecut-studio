from __future__ import annotations

import math

import numpy as np

from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.breath_detect import (
    _LEVEL_CONTEXT_SEC,
    _audio_reader,
    _breath_cfg,
    _ClearEdge,
    _CompleteEdgeBreath,
    _edge_evidence,
    _kept_spans,
    _mostly_breath,
    _read_evidence,
    _UncertainEdge,
)
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.engines.level_profile import LEVEL_FRAME_SEC, level_profile
from podcast_mcp.models import EpisodeProject


def protect_cut_breaths(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    defaults: dict | None = None,
    sample_rate: int = 16000,
    audio_cache: TrackAudioCache | None = None,
    word_index: CutWordIndex | None = None,
    strict: bool = True,
) -> tuple[float, float] | None:
    """Shrink final edges around complete breaths, or suppress uncertain cuts."""
    if not (math.isfinite(start) and math.isfinite(end) and start < end):
        return None
    cfg = _breath_cfg(defaults)
    if not cfg["enabled"]:
        return start, end
    no_evidence = None if strict else (start, end)
    read = _audio_reader(project, track_id, sample_rate, audio_cache)
    if read is None:
        return no_evidence
    context_start = max(
        0.0, math.floor((start - _LEVEL_CONTEXT_SEC) / LEVEL_FRAME_SEC + 1e-9) * LEVEL_FRAME_SEC
    )
    before_end = math.floor(start / LEVEL_FRAME_SEC + 1e-9) * LEVEL_FRAME_SEC
    after_start = math.ceil(end / LEVEL_FRAME_SEC - 1e-9) * LEVEL_FRAME_SEC
    before = _read_evidence(read, context_start, before_end - context_start)
    after = _read_evidence(read, after_start, _LEVEL_CONTEXT_SEC)
    context = np.concatenate([before, after])
    if not np.all(np.isfinite(context)):
        return no_evidence
    profile = level_profile(context, sample_rate)
    if profile is None:
        return no_evidence
    words = word_index or CutWordIndex.build(project, track_id)
    windows = []
    for edge in (start, end):
        origin = max(
            0.0,
            math.floor((edge - _LEVEL_CONTEXT_SEC) / LEVEL_FRAME_SEC + 1e-9) * LEVEL_FRAME_SEC,
        )
        samples = _read_evidence(read, origin, edge + _LEVEL_CONTEXT_SEC - origin)
        windows.append((origin, samples))

    def inspect(
        edge: float, window: tuple[float, np.ndarray], bounds: tuple[float, float]
    ) -> _ClearEdge | _CompleteEdgeBreath | _UncertainEdge:
        origin, samples = window
        keep_out = _kept_spans(words, origin, origin + samples.size / sample_rate, *bounds)
        return _edge_evidence(
            samples,
            origin,
            edge,
            sample_rate=sample_rate,
            profile=profile,
            cfg=cfg,
            keep_out=keep_out,
        )

    evidence = [
        inspect(edge, window, (start, end))
        for edge, window in zip((start, end), windows, strict=True)
    ]
    if strict and any(isinstance(item, _UncertainEdge) for item in evidence):
        return None
    new_start = evidence[0].span.end if isinstance(evidence[0], _CompleteEdgeBreath) else start
    new_end = evidence[1].span.start if isinstance(evidence[1], _CompleteEdgeBreath) else end
    if new_start >= new_end:
        return None
    if strict:
        for edge, window in zip((start, end), windows, strict=True):
            if isinstance(inspect(edge, window, (new_start, new_end)), _UncertainEdge):
                return None
    elif _mostly_breath(
        new_start,
        new_end,
        read=read,
        words=words,
        profile=profile,
        cfg=cfg,
        sample_rate=sample_rate,
    ):
        return None
    return new_start, new_end
