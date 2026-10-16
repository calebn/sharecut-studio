from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum

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
from podcast_mcp.edits.join_continuity import assess_proposed_cut
from podcast_mcp.edits.source_removals import (
    CutScopeHold,
    _inspect_source_remove_placement_impl,
)
from podcast_mcp.edits.speech_energy_guard import assess_cross_track_speech
from podcast_mcp.engines.level_profile import LEVEL_FRAME_SEC, level_profile
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EditDecision, EditDecisionType, EpisodeProject
from podcast_mcp.util.timebase import SourceSec, TimelineSec

__all__ = [
    "CUT_EDGE_CHECKS",
    "BreathEdgeAction",
    "CutEdgeChecks",
    "CutJoin",
    "assess_cross_track_speech",
    "assess_proposed_cut",
    "inspect_source_remove_placement",
    "pending_pad_source_spans",
    "protect_cut_breaths",
    "protect_cut_edges",
]


class CutJoin(Enum):
    SPLICE = "splice"
    PADDED = "padded"
    MUTE = "mute"


class BreathEdgeAction(Enum):
    PROTECT = "protect"
    KEEP_WHOLE = "keep_whole"
    IGNORE = "ignore"


@dataclass(frozen=True)
class CutEdgeChecks:
    breaths: BreathEdgeAction
    score_joins: bool
    end_before_next_onset: bool
    keep_whole_words: bool
    refuse_attached_runs: bool
    audible_only: bool
    peer_scoped: bool


CUT_EDGE_CHECKS = {
    CutJoin.SPLICE: CutEdgeChecks(
        breaths=BreathEdgeAction.PROTECT,
        score_joins=True,
        end_before_next_onset=False,
        keep_whole_words=False,
        refuse_attached_runs=False,
        audible_only=False,
        peer_scoped=True,
    ),
    CutJoin.PADDED: CutEdgeChecks(
        breaths=BreathEdgeAction.IGNORE,
        score_joins=False,
        end_before_next_onset=True,
        keep_whole_words=True,
        refuse_attached_runs=False,
        audible_only=False,
        peer_scoped=True,
    ),
    CutJoin.MUTE: CutEdgeChecks(
        breaths=BreathEdgeAction.KEEP_WHOLE,
        score_joins=False,
        end_before_next_onset=True,
        keep_whole_words=True,
        refuse_attached_runs=True,
        audible_only=True,
        peer_scoped=False,
    ),
}


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


def inspect_source_remove_placement(
    project: EpisodeProject, edit: EditDecision
) -> tuple[TimelineSec, TimelineSec] | CutScopeHold:
    """Check source placement through the cut-safety entry point."""
    return _inspect_source_remove_placement_impl(project, edit, check_witness=True)


def protect_cut_edges(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    join: CutJoin,
    defaults: dict | None = None,
    sample_rate: int = 16000,
    audio_cache: TrackAudioCache | None = None,
    word_index: CutWordIndex | None = None,
) -> tuple[float, float] | None:
    action = CUT_EDGE_CHECKS[join].breaths
    if action is BreathEdgeAction.IGNORE:
        return start, end
    return protect_cut_breaths(
        project,
        track_id,
        start,
        end,
        defaults=defaults,
        sample_rate=sample_rate,
        audio_cache=audio_cache,
        word_index=word_index,
        strict=action is BreathEdgeAction.PROTECT,
    )


def pending_pad_source_spans(
    project: EpisodeProject, besides: EditDecision
) -> dict[str, list[tuple[float, float]]]:
    timeline = SessionTimeline(project)
    spans: dict[str, list[tuple[float, float]]] = {}
    for other in project.edit_decisions:
        if (
            other.id == besides.id
            or other.applied
            or other.exact_range is not None
            or other.type not in (EditDecisionType.REMOVE, EditDecisionType.MUTE)
            or not timeline.map_source_span(
                other.track_id, SourceSec(other.start), SourceSec(other.end)
            )
        ):
            continue
        spans.setdefault(other.track_id, []).append((other.start, other.end))
    return spans
