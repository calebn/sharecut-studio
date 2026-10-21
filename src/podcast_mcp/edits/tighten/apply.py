"""Resolving analyzed cuts into decisions and the analyze_fillers_and_pauses facade."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import TYPE_CHECKING, Any

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits.acoustic_gap import (
    AcousticGapConfig,
)
from podcast_mcp.edits.audio_cache import build_track_audio_caches
from podcast_mcp.edits.cut_placement import CutRejected
from podcast_mcp.edits.filler_pacing import (
    pause_trim_is_imperceptible,
)
from podcast_mcp.edits.mute_regions import (
    muted_source_spans,
    source_span_is_muted,
)
from podcast_mcp.edits.peer_copy_lag import PeerCopyLags
from podcast_mcp.edits.shared_pause import PauseClaim, shared_pause_twins
from podcast_mcp.edits.tighten_intensity import with_tighten_intensity
from podcast_mcp.models import (
    ClipMuteRegion,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    Transcript,
)
from podcast_mcp.util.intervals import HalfOpenIntervalIndex
from podcast_mcp.util.tracks import dialogue_track_ids

if TYPE_CHECKING:
    pass
from podcast_mcp.edits.pause_floor import peer_speech_indexes
from podcast_mcp.edits.tighten.acoustic_scan import _add_acoustic_candidates
from podcast_mcp.edits.tighten.candidate import (
    _AnalyzedCut,
    _count_skip,
    _CutCandidate,
    _speaker_cut_context,
    _word_indexes,
)
from podcast_mcp.edits.tighten.collect import (
    _collect_candidates,
)
from podcast_mcp.edits.tighten.prepare import (
    analyze_candidates,
)


def _resolve_analyzed_cuts(
    candidates: list[_CutCandidate],
    results: list[_AnalyzedCut | CutRejected],
    *,
    existing: Iterable[EditDecision] = (),
    muted: Mapping[str, Sequence[ClipMuteRegion]] | None = None,
    skip_counts: dict[str, int] | None = None,
    project: EpisodeProject | None = None,
) -> list[_AnalyzedCut]:
    """Resolve overlaps between analyzed cuts, preserving candidate order.

    Runs after analysis so it sees final (post-pacing) spans:

    * A cut overlapping an already *applied* decision in ``existing`` on the
      same track is dropped: applying does not suppress transcript words, so
      re-proposal would otherwise stack a pending duplicate over approved audio
      (coalescing never merges across ``applied``).
    * A cut whose hit id (:attr:`_CutCandidate.hit_id`) a decision in
      ``existing`` or an earlier cut already holds is dropped: it is that same hit
      again, and decision ids stay unique.
    * A strictly bounded (acoustic) cut overlapping a surviving word-based cut on
      the same track is dropped -- pacing may have widened ``filler:um`` across
      the gap.
    * A pause trim is replaced only by an acoustic cut that *survived* analysis;
      when the acoustic candidate is rejected the pause trim still stands.
    * With a ``project``, a session pause trim that another track's longer trim
      stands for (the same stretch of shared air, :func:`shared_pause_twins`) is dropped
      as ``shared_pause``: the reviewer decides that cut once. Only trims that survived
      everything above count, so a trim lost to the join gate or an overlap leaves its
      twin standing.

    """
    applied_spans: dict[str, list[tuple[float, float]]] = {}
    held_ids: set[str] = set()
    for decision in existing:
        held_ids.add(decision.id)
        if decision.applied:
            applied_spans.setdefault(decision.track_id, []).append((decision.start, decision.end))
    applied_index = {
        tid: HalfOpenIntervalIndex.build(spans) for tid, spans in applied_spans.items()
    }
    pairs: list[tuple[_CutCandidate, _AnalyzedCut | None]] = []
    for candidate, outcome in zip(candidates, results, strict=True):
        if isinstance(outcome, CutRejected):
            prefix = (
                "acoustic:"
                if candidate.strictly_bounded and outcome.skip != "scope_unavailable"
                else ""
            )
            _count_skip(skip_counts, f"{prefix}{outcome.skip}")
        result = outcome if isinstance(outcome, _AnalyzedCut) else None
        index = applied_index.get(candidate.track_id)
        if result is not None and index is not None and index.overlaps(result.start, result.end):
            _count_skip(skip_counts, "applied_overlap")
            result = None
        if (
            result is not None
            and result.decision_type == "mute"
            and source_span_is_muted(
                (muted or {}).get(candidate.track_id, ()), result.start, result.end
            )
        ):
            _count_skip(skip_counts, "already_muted")
            result = None
        if result is not None and result.hit_id in held_ids:
            _count_skip(skip_counts, "same_hit")
            result = None
        if result is not None and project is not None and result.decision_type == "remove":
            from podcast_mcp.edits.cut_placement import CutScopeHold
            from podcast_mcp.edits.cut_safety import inspect_source_remove

            assessed = inspect_source_remove(
                project,
                _decision_for_analyzed(result),
                heard_pause_sec=result.pause_sec,
            )
            if isinstance(assessed, CutScopeHold):
                _count_skip(
                    skip_counts,
                    "imperceptible"
                    if assessed.reason == "pause_imperceptible"
                    else assessed.reason,
                )
                result = None
        if result is not None:
            held_ids.add(result.hit_id)
        pairs.append((candidate, result))
    word_spans: dict[str, list[tuple[float, float]]] = {}
    for candidate, result in pairs:
        if result is not None and candidate.cut_kind != "pause" and not candidate.strictly_bounded:
            word_spans.setdefault(candidate.track_id, []).append((result.start, result.end))
    word_index = {tid: HalfOpenIntervalIndex.build(spans) for tid, spans in word_spans.items()}

    dropped: set[int] = set()
    bounded_spans: dict[str, list[tuple[float, float]]] = {}
    for idx, (candidate, result) in enumerate(pairs):
        if not candidate.strictly_bounded or result is None:
            continue
        index = word_index.get(candidate.track_id)
        if index is not None and index.overlaps(result.start, result.end):
            _count_skip(skip_counts, "acoustic:overlaps_cut")
            dropped.add(idx)
            continue
        bounded_spans.setdefault(candidate.track_id, []).append((result.start, result.end))
    bounded_index = {
        tid: HalfOpenIntervalIndex.build(spans) for tid, spans in bounded_spans.items()
    }

    for idx, (candidate, result) in enumerate(pairs):
        if result is None or candidate.cut_kind != "pause":
            continue
        index = bounded_index.get(candidate.track_id)
        if index is not None and index.overlaps(result.start, result.end):
            _count_skip(skip_counts, "acoustic:replaced_pause")
            dropped.add(idx)
    for idx, (candidate, result) in enumerate(pairs):
        if (
            project is None
            and result is not None
            and idx not in dropped
            and (heard := result.pause_sec or candidate.pause_sec) is not None
            and pause_trim_is_imperceptible(
                result.end - result.start - (result.replace_gap_sec or 0.0), heard
            )
        ):
            _count_skip(skip_counts, "imperceptible")
            dropped.add(idx)
    if project is not None:
        twins = shared_pause_twins(
            project,
            [
                PauseClaim(result.track_id, result.start, result.end)
                if result is not None
                and idx not in dropped
                and candidate.cut_kind == "pause"
                and result.scope == "session"
                else None
                for idx, (candidate, result) in enumerate(pairs)
            ],
        )
        for _ in twins:
            _count_skip(skip_counts, "shared_pause")
        dropped |= twins
    return [
        result
        for idx, (_candidate, result) in enumerate(pairs)
        if result is not None and idx not in dropped
    ]


def _decision_for_analyzed(result: _AnalyzedCut) -> EditDecision:
    return EditDecision(
        id=result.hit_id,
        track_id=result.track_id,
        type=EditDecisionType.MUTE if result.decision_type == "mute" else EditDecisionType.REMOVE,
        start=result.start,
        end=result.end,
        reason=result.reason,
        review_required=result.review_required,
        applied=False,
        crossfade_ms=result.crossfade_ms,
        cut_confidence=result.cut_confidence,
        boundary_mode=result.boundary_mode,
        replace_gap_sec=result.replace_gap_sec,
        next_burst_sec=result.next_burst_sec,
        scope=result.scope,
    )


def _apply_analyzed_cut(
    project: EpisodeProject, result: _AnalyzedCut, *, defaults: EffectiveConfig
) -> EditDecision:
    from podcast_mcp.edits.source_removals import (
        record_suggested_cut_speech,
        require_source_remove,
    )

    decision = _decision_for_analyzed(result)
    require_source_remove(project, decision, heard_pause_sec=result.pause_sec)
    if decision.review_required and (
        (decision.reason or "").startswith("pause:") or result.peers_speaking
    ):
        record_suggested_cut_speech(project, decision, defaults=defaults)
    project.edit_decisions.append(decision)
    return decision


def analyze_fillers_and_pauses(
    project: EpisodeProject,
    transcript: Transcript,
    defaults: dict[str, Any],
    *,
    skip_counts: dict[str, int] | None = None,
) -> list[EditDecision]:
    """Serial, single-transcript entry point (kept for direct/standalone callers
    and tests). The pipeline's hot path (propose_tighten_edits in edits/tighten/propose.py)
    instead flattens candidates across ALL transcripts and analyzes them in
    parallel before applying decisions serially -- see that module for why.

    Still builds a decode-once audio cache for this one track (see
    edits/audio_cache.py) so direct callers get the same speedup as the pipeline
    path, just without cross-track parallelism.

    Resolves ``tighten.intensity`` the same way (:func:`~podcast_mcp.edits.tighten_intensity.with_tighten_intensity`).
    """
    defaults = with_tighten_intensity(defaults)
    peer_indexes = peer_speech_indexes(project)
    candidates = _collect_candidates(
        transcript,
        defaults,
        project=project,
        skip_counts=skip_counts,
        peer_indexes=peer_indexes,
    )
    acoustic_enabled = AcousticGapConfig.from_tighten(defaults.get("tighten")).enabled
    # Peers too: a session ripple removes the same window from every dialogue
    # track, and the voiced-speech check reads each one it can.
    audio_caches = (
        build_track_audio_caches(
            project, dict.fromkeys([transcript.track_id, *dialogue_track_ids(project)])
        )
        if candidates or acoustic_enabled
        else {}
    )
    audio_cache = audio_caches.get(transcript.track_id)
    candidates = _add_acoustic_candidates(
        candidates,
        transcript,
        defaults,
        project=project,
        audio_cache=audio_cache,
        audio_caches=audio_caches,
        copy_lags=PeerCopyLags(project),
        skip_counts=skip_counts,
    )
    speaker_context = _speaker_cut_context(project) if candidates else None
    word_indexes = _word_indexes(project, candidates)
    results = analyze_candidates(
        project,
        candidates,
        defaults,
        audio_caches=audio_caches,
        speaker_context=speaker_context,
        peer_indexes=peer_indexes,
        word_indexes=word_indexes,
        max_workers=1,
    )
    resolved = _resolve_analyzed_cuts(
        candidates,
        results,
        existing=list(project.edit_decisions),
        muted=muted_source_spans(project),
        skip_counts=skip_counts,
        project=project,
    )
    return [_apply_analyzed_cut(project, result, defaults=defaults) for result in resolved]
