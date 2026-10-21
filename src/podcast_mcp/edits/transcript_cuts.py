from __future__ import annotations

import uuid
from collections.abc import Sequence
from typing import Any

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.edits import filler_pacing
from podcast_mcp.edits.cut_application import assess_source_offer
from podcast_mcp.edits.cut_placement import CutScopeHold, inspect_source_remove_placement
from podcast_mcp.edits.cut_policy import decision_policy
from podcast_mcp.edits.cut_safety import CutScopeUnavailable, resolve_cut_scope
from podcast_mcp.edits.edit_reasons import (
    GUEST_SUGGEST_SPLIT_REASON,
    NL_MANUAL_REASON,
    NL_MATCH_REASON_PREFIX,
    NL_RANGE_REASON,
    NL_UTTERANCE_REASON_PREFIX,
    NL_WORDS_REASON,
)
from podcast_mcp.edits.filler_pacing import paced_pad_for_span
from podcast_mcp.edits.inaudible_cuts import CutWordIndex, optimize_source_cut_range
from podcast_mcp.edits.source_removals import (
    ScopeChangedAtApproval,
    inspect_source_remove,
    record_suggested_cut_speech,
    require_source_remove,
)
from podcast_mcp.edits.speech_energy_guard import PeerSpeechBlocked
from podcast_mcp.edits.transcript_search import ensure_combined_transcript, search_transcript
from podcast_mcp.engines.session_timeline import SessionTimeline, clip_plays_lane
from podcast_mcp.models import (
    CombinedTranscript,
    CutIntent,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    Transcript,
)
from podcast_mcp.models.episode import RangeInterval
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.timebase import SourceSec


def time_range_from_words(
    transcript: Transcript,
    start_word_index: int,
    end_word_index: int,
) -> tuple[float, float]:
    words = transcript.words
    if not words:
        raise CodedValueError(
            "Transcript has no words. Transcribe that track first.", code="no_transcript_words"
        )
    start = max(0, min(start_word_index, len(words) - 1))
    end = max(start, min(end_word_index, len(words) - 1))
    return words[start].start, words[end].end


def time_range_from_utterance(
    combined: CombinedTranscript,
    utterance_index: int,
) -> tuple[str, str | None, float, float, str]:
    if utterance_index < 0 or utterance_index >= len(combined.utterances):
        raise CodedValueError(
            f"Utterance index out of range: {utterance_index}", code="utterance_index_out_of_range"
        )
    utt = combined.utterances[utterance_index]
    return utt.track_id, utt.source_id, utt.start, utt.end, utt.text


def _cut_transcript_for_source(
    project: EpisodeProject, track_id: str, source_id: str | None
) -> Transcript | None:
    return project.transcript_for_source(track_id, source_id)


def append_remove_decision(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    reason: str = NL_MANUAL_REASON,
    review_required: bool = True,
    crossfade_ms: int = 10,
    cut_confidence: float | None = None,
    boundary_mode: str | None = None,
    replace_gap_sec: float | None = None,
    next_burst_sec: float | None = None,
    scope: str = "session",
    decision_type: EditDecisionType = EditDecisionType.REMOVE,
    decision_id: str | None = None,
    author: str | None = None,
    defaults: EffectiveConfig,
) -> EditDecision:
    """Append a remove or mute decision without waveform optimization or coalescing.

    ``decision_id`` is the generator's stable hit id; omitted, the id is random.
    """
    if end <= start:
        raise CodedValueError(
            "end must be greater than start. Pick an end after the start.",
            code="range_end_before_start",
        )
    if decision_type not in (EditDecisionType.REMOVE, EditDecisionType.MUTE):
        raise CodedValueError("decision_type must be remove or mute", code="edit_type_invalid")
    decision = EditDecision(
        id=decision_id or f"cut_{uuid.uuid4().hex[:8]}",
        track_id=track_id,
        type=decision_type,
        start=start,
        end=end,
        crossfade_ms=crossfade_ms,
        reason=reason,
        review_required=review_required,
        applied=False,
        cut_confidence=cut_confidence,
        boundary_mode=boundary_mode,
        replace_gap_sec=replace_gap_sec,
        next_burst_sec=next_burst_sec,
        scope=scope,
        author=author,
    )

    require_source_remove(project, decision)

    assess_source_offer(project, decision, defaults=defaults)
    project.edit_decisions.append(decision)
    return decision


def append_split_decision(
    project: EpisodeProject,
    at_time: float,
    track_ids: list[str],
    *,
    reason: str = GUEST_SUGGEST_SPLIT_REASON,
    review_required: bool = True,
    author: str | None = None,
) -> EditDecision:
    """Append a pending blade/split decision (timeline clock, start == end)."""
    if not track_ids:
        raise CodedValueError(
            "track_ids required for split proposal. Pass at least one track id.",
            code="track_ids_empty",
        )
    decision = EditDecision(
        id=f"split_{uuid.uuid4().hex[:8]}",
        track_id=track_ids[0],
        type=EditDecisionType.SPLIT,
        start=float(at_time),
        end=float(at_time),
        crossfade_ms=0,
        reason=reason,
        review_required=review_required,
        applied=False,
        track_ids=list(track_ids),
        timebase="timeline",
        boundary_mode="timeline_split",
        author=author,
    )
    project.edit_decisions.append(decision)
    return decision


def add_remove_decision(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    reason: str = NL_MANUAL_REASON,
    review_required: bool = True,
    crossfade_ms: int = 10,
    use_inaudible_opt: bool | None = None,
    defaults: EffectiveConfig,
    source_id: str | None = None,
    source_aware: bool = False,
    merge_ids: set[str] | None = None,
) -> EditDecision:
    if end <= start:
        raise CodedValueError(
            "end must be greater than start. Pick an end after the start.",
            code="range_end_before_start",
        )

    transcript = _cut_transcript_for_source(project, track_id, source_id) if source_aware else None
    if source_aware and transcript is None and source_id is not None:
        raise CodedValueError(
            f"No transcript for track {track_id} source {source_id}. Transcribe that track first.",
            code="transcript_not_found",
        )
    selected_source_ids = project.equivalent_source_ids(track_id, source_id)
    selected_clips = any(
        clip_plays_lane(project, clip, track_id) and clip.source_id in selected_source_ids
        for clip in project.clips
    )
    has_lane_clips = any(clip_plays_lane(project, clip, track_id) for clip in project.clips)
    timeline = SessionTimeline(project)
    initial_spans = (
        timeline.map_placements_source_span(
            track_id, selected_source_ids, SourceSec(start), SourceSec(end)
        )
        if source_aware and selected_clips
        else timeline.map_source_span(track_id, SourceSec(start), SourceSec(end))
        if source_aware and None in selected_source_ids and not has_lane_clips
        else []
    )
    if source_aware and (
        len(initial_spans) != 1
        or abs(float(initial_spans[0][1] - initial_spans[0][0]) - (end - start)) > 1e-6
    ):
        raise ScopeChangedAtApproval([CutScopeHold("source-request", (), "source_geometry")], {})
    placement_witness = (
        RangeInterval(start=float(initial_spans[0][0]), end=float(initial_spans[0][1]))
        if source_aware
        else None
    )
    placement = inspect_source_remove_placement(
        project,
        EditDecision(
            id="source-request",
            track_id=track_id,
            type=EditDecisionType.REMOVE,
            start=start,
            end=end,
            reason=reason,
            applied=False,
            source_id=source_id,
            source_timeline_span=placement_witness,
        ),
    )
    if isinstance(placement, CutScopeHold):
        raise ScopeChangedAtApproval([placement], {})
    # Pace from the requested span first so waveform snap cannot pull a boundary
    # onto the next word and then room-tone-expand across real dialogue.
    pacing_kwargs: dict[str, Any] = {"defaults": defaults, "cut_kind": "nl"}
    if source_aware:
        pacing_kwargs["transcript"] = transcript
    paced = filler_pacing.apply_filler_pacing(project, track_id, start, end, **pacing_kwargs)
    if paced is None:
        raise CodedValueError(
            "cut would leave flanking words closer than min_gap_after_filler_sec; "
            "widen the retained gap or leave this hesitation in",
            code="filler_gap_too_small",
        )
    optimizer_kwargs: dict[str, Any] = {"force_enabled": use_inaudible_opt, "defaults": defaults}
    if source_aware:
        optimizer_kwargs.update(source_id=source_id)
        if transcript is not None:
            optimizer_kwargs["word_index"] = CutWordIndex.from_transcript(transcript, track_id)
    opt = optimize_source_cut_range(project, track_id, paced.start, paced.end, **optimizer_kwargs)
    # Keep room-tone pad intent; clamp optimized bounds inside the paced window.
    # Trailing-energy may extend past ``paced.end`` only when the next ASR token
    # overlaps the filler (um→you); otherwise keep lead-in on the next onset
    # (know→like) so it doesn't start cold after the silence pad.
    cut_start, cut_end = opt.start, opt.end
    if paced.pad is not None:
        cut_start = min(max(cut_start, paced.start), paced.end)
        if paced.allow_trailing_past_end and opt.details.get("trailing_energy_extended"):
            cut_end = max(cut_end, cut_start + 0.001)
        else:
            cut_end = max(min(cut_end, paced.end), cut_start)
    if cut_end <= cut_start:
        cut_start, cut_end = paced.start, paced.end

    if source_aware:
        final_timeline = SessionTimeline(project)
        if selected_clips:
            final_spans = final_timeline.map_placements_source_span(
                track_id, selected_source_ids, SourceSec(cut_start), SourceSec(cut_end)
            )
        elif None in selected_source_ids and not has_lane_clips:
            final_spans = final_timeline.map_source_span(
                track_id, SourceSec(cut_start), SourceSec(cut_end)
            )
        else:
            final_spans = []
    else:
        final_spans = []
    if source_aware and (
        len(final_spans) != 1
        or abs(float(final_spans[0][1] - final_spans[0][0]) - (cut_end - cut_start)) > 1e-6
    ):
        raise ScopeChangedAtApproval([CutScopeHold("source-request", (), "source_geometry")], {})
    if source_aware:
        placement_witness = RangeInterval(
            start=float(final_spans[0][0]), end=float(final_spans[0][1])
        )

    replace_gap = None if paced.pad is None else paced.pad.seconds(cut_start, cut_end)
    review = review_required
    cut_reason = reason
    decision_id = f"cut_{uuid.uuid4().hex[:8]}"
    resolved = resolve_cut_scope(
        project,
        track_id,
        cut_start,
        cut_end,
        defaults=defaults,
        _admissible_spans=(
            [(float(placement_witness.start), float(placement_witness.end))]
            if placement_witness is not None
            else None
        ),
    )
    if isinstance(resolved, CutScopeUnavailable):
        raise ScopeChangedAtApproval([CutScopeHold(decision_id, (), "scope_unavailable")], {})
    guard = resolved.guard
    if guard is not None and guard.action == "skip":
        raise PeerSpeechBlocked(guard.blocking_track_ids)
    if guard is not None and guard.blocked:
        peers = ",".join(guard.blocking_track_ids)
        review = True
        cut_reason = f"{reason}:other_speaking:{peers}"
    elif resolved.scope == "track":
        review = True

    decision = EditDecision(
        id=decision_id,
        track_id=track_id,
        type=EditDecisionType.REMOVE,
        start=cut_start,
        end=cut_end,
        crossfade_ms=crossfade_ms,
        reason=cut_reason,
        review_required=review,
        applied=False,
        cut_confidence=opt.confidence,
        boundary_mode=opt.mode,
        replace_gap_sec=replace_gap,
        source_id=source_id if source_aware else None,
        source_timeline_span=placement_witness,
    )
    require_source_remove(project, decision)
    if guard is not None and guard.blocked:
        record_suggested_cut_speech(project, decision, defaults=defaults)
    staged = project.model_copy(deep=True)
    staged.edit_decisions.append(decision)
    complete_primary_witness = source_aware and source_id is None
    joining_ids = _joining_remove_ids(
        staged.edit_decisions,
        decision.id,
        merge_gap_sec=0.05,
        allow_primary_witness_completion=complete_primary_witness,
    )
    if merge_ids is not None:
        joining_ids &= merge_ids | {decision.id}
    coalesce_edits(
        staged,
        track_id=track_id,
        defaults=defaults,
        merge_ids=joining_ids,
        allow_primary_witness_completion=complete_primary_witness,
    )
    same_id = [row for row in staged.edit_decisions if row.id == decision.id]
    candidates = same_id or [
        row
        for row in staged.edit_decisions
        if row.id in joining_ids
        and not _keeps_independent_review(row, decision)
        and _ordinary_remove_survivor(row, decision)
    ]
    if len(candidates) != 1 or not _ordinary_remove_survivor(candidates[0], decision):
        raise RuntimeError("source remove has no unique ordinary survivor")
    survivor = candidates[0]

    assess_source_offer(staged, survivor, defaults=defaults)
    project.edit_decisions = staged.edit_decisions
    return survivor


def _same_merge_identity(
    left: EditDecision,
    right: EditDecision,
    *,
    allow_primary_witness_completion: bool = False,
) -> bool:
    return (
        left.track_id == right.track_id
        and left.type == right.type
        and left.timebase == right.timebase
        and left.scope == right.scope
        and left.author == right.author
        and left.applied == right.applied
        and left.source_id == right.source_id
        and (
            (left.source_timeline_span is not None) == (right.source_timeline_span is not None)
            or (
                allow_primary_witness_completion
                and left.source_id is None
                and right.source_id is None
            )
        )
        and left.boundary_mode == right.boundary_mode
        and left.cut_speech == right.cut_speech
        and left.exact_range is None
        and right.exact_range is None
    )


def _ordinary_remove_survivor(row: EditDecision, requested: EditDecision) -> bool:
    return (
        row.type == EditDecisionType.REMOVE
        and row.timebase == "source"
        and _same_merge_identity(row, requested)
        and row.start <= requested.start
        and row.end >= requested.end
    )


def _merge_groups(
    rows: Sequence[EditDecision],
    *,
    merge_gap_sec: float,
    allow_primary_witness_completion: bool = False,
) -> tuple[tuple[EditDecision, ...], ...]:
    by_key: dict[tuple[str, EditDecisionType], list[EditDecision]] = {}
    for row in rows:
        if row.type in (EditDecisionType.REMOVE, EditDecisionType.MUTE) and row.exact_range is None:
            by_key.setdefault((row.track_id, row.type), []).append(row)
    groups: list[tuple[EditDecision, ...]] = []
    for edits in by_key.values():
        ordered = sorted(edits, key=lambda row: row.start)
        group = [ordered[0]]
        hull = ordered[0].model_copy(deep=True)
        for row in ordered[1:]:
            if (
                row.start <= hull.end + merge_gap_sec
                and _same_merge_identity(
                    hull, row, allow_primary_witness_completion=allow_primary_witness_completion
                )
                and not _keeps_independent_review(hull, row)
            ):
                hull.end = max(hull.end, row.end)
                hull.review_required = hull.review_required or row.review_required
                group.append(row)
            else:
                groups.append(tuple(group))
                group = [row]
                hull = row.model_copy(deep=True)
        groups.append(tuple(group))
    return tuple(groups)


def _joining_remove_ids(
    rows: Sequence[EditDecision],
    new_id: str,
    *,
    merge_gap_sec: float,
    allow_primary_witness_completion: bool = False,
) -> set[str]:
    for group in _merge_groups(
        rows,
        merge_gap_sec=merge_gap_sec,
        allow_primary_witness_completion=allow_primary_witness_completion,
    ):
        if any(row.id == new_id for row in group):
            return {row.id for row in group}
    raise RuntimeError("source remove has no coalescing group")


def coalesce_edits(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    merge_gap_sec: float = 0.05,
    defaults: EffectiveConfig,
    skip_counts: dict[str, int] | None = None,
    merge_ids: set[str] | None = None,
    allow_primary_witness_completion: bool = False,
) -> int:
    """Merge overlapping/adjacent same-track REMOVE/MUTE decisions with matching boundary modes.

    A merged cut that any padded cut went into is padded again from the merged span
    (``defaults`` supplies the pacing rule; see :func:`_merged_pad_sec`).

    Interactive primary transcript cuts may complete a missing placement witness;
    the merged source interval is still mapped and validated before publication.
    """
    if merge_ids == set():
        return 0
    owned = [
        row
        for row in project.edit_decisions
        if (merge_ids is None or row.id in merge_ids)
        and (track_id is None or row.track_id == track_id)
        and row.type in (EditDecisionType.REMOVE, EditDecisionType.MUTE)
        and row.exact_range is None
    ]
    owned_ids = {row.id for row in owned}
    result = [row for row in project.edit_decisions if row.id not in owned_ids]
    merged_count = 0

    for rows in _merge_groups(
        owned,
        merge_gap_sec=merge_gap_sec,
        allow_primary_witness_completion=allow_primary_witness_completion,
    ):
        if skip_counts is None:
            for row in rows:
                if (
                    row.type == EditDecisionType.REMOVE
                    and not row.applied
                    and row.timebase == "source"
                ):
                    require_source_remove(project, row)
        group = [row.model_copy(deep=True) for row in rows]
        survivor = group[0]
        for row in group[1:]:
            if row.end > survivor.end:
                survivor.next_burst_sec = row.next_burst_sec
            survivor.end = max(survivor.end, row.end)
            survivor.review_required = survivor.review_required or row.review_required
        merged_count += len(group) - 1
        if len(group) > 1:
            survivor.boundary_intent = CutIntent.PROGRAMMATIC
            survivor.replace_gap_sec = _merged_pad_sec(project, group, defaults)
            if any(row.source_timeline_span is not None for row in group):
                timeline = SessionTimeline(project)
                has_lane_clips = any(
                    clip_plays_lane(project, clip, survivor.track_id) for clip in project.clips
                )
                selected_source_ids = project.equivalent_source_ids(
                    survivor.track_id, survivor.source_id
                )
                if None in selected_source_ids and not has_lane_clips:
                    merged_spans = timeline.map_source_span(
                        survivor.track_id, SourceSec(survivor.start), SourceSec(survivor.end)
                    )
                elif has_lane_clips:
                    merged_spans = timeline.map_placements_source_span(
                        survivor.track_id,
                        selected_source_ids,
                        SourceSec(survivor.start),
                        SourceSec(survivor.end),
                    )
                else:
                    merged_spans = []
                if (
                    len(merged_spans) != 1
                    or abs(
                        float(merged_spans[0][1] - merged_spans[0][0])
                        - (survivor.end - survivor.start)
                    )
                    > 1e-6
                ):
                    if skip_counts is None:
                        raise ScopeChangedAtApproval(
                            [CutScopeHold(survivor.id, (), "source_geometry")], {}
                        )
                    skip_counts["source_geometry"] = skip_counts.get("source_geometry", 0) + 1
                    continue
                survivor.source_timeline_span = RangeInterval(
                    start=float(merged_spans[0][0]), end=float(merged_spans[0][1])
                )
        if (
            survivor.type == EditDecisionType.REMOVE
            and not survivor.applied
            and survivor.timebase == "source"
        ):
            if skip_counts is None:
                require_source_remove(project, survivor)
            else:
                assessment = inspect_source_remove(project, survivor)
                if isinstance(assessment, CutScopeHold):
                    skip_counts[assessment.reason] = skip_counts.get(assessment.reason, 0) + 1
                    continue
        if len(group) > 1:
            assess_source_offer(project, survivor, defaults=defaults)
        result.append(survivor)
    project.edit_decisions = result
    return merged_count


def _merged_pad_sec(
    project: EpisodeProject, group: list[EditDecision], defaults: EffectiveConfig
) -> float | None:
    """The pad for the cut ``group`` merged into; ``group[0]`` already spans the merge.

    Padded filler and NL cuts are paced again from the merged span, so a cut that now
    removes more is padded for what it removes instead of keeping the larger old pad
    (#1129). A pause's pad is not paced: it makes up a retained stretch that earlier
    ripples shortened, so the largest of those is kept beside the paced pad.
    """
    padded = [e for e in group if e.replace_gap_sec is not None]
    shortfalls = [e.replace_gap_sec or 0.0 for e in padded if _is_pause(e)]
    pad_sec = max(shortfalls, default=0.0)
    if len(shortfalls) < len(padded):
        top = group[0]
        paced = paced_pad_for_span(
            project,
            top.track_id,
            top.start,
            top.end,
            defaults,
            transcript=_cut_transcript_for_source(project, top.track_id, top.source_id)
            if top.source_timeline_span is not None
            else None,
        )
        pad_sec = max(pad_sec, paced.seconds(top.start, top.end))
    return pad_sec if pad_sec > 0 else None


def _is_pause(edit: EditDecision) -> bool:
    return (edit.reason or "").startswith("pause:")


def _keeps_independent_review(left: EditDecision, right: EditDecision) -> bool:
    """Keep generated review-only proposals and approval state separate.

    Repeat/restart, ``filler:acoustic`` and pause reasons and ids identify one
    specific proposal a human must approve.  A neighboring filler can be safely
    coalesced with ordinary cuts, but merging it into one of these proposals
    loses that review context (or auto-applies an acoustic span nobody heard).
    Decisions whose ``applied`` flags differ are never merged either: the merged
    edit would silently apply the pending span or un-apply the approved one.
    Nor are decisions with different authors: the merged edit keeps one author,
    which would grant a share guest another author's span or drop its own. A pause
    trim is one of these proposals (#1055), reviewed or applied: merged into a filler, a
    track-local cut or an NL cut it would lose its label, its air-edge flag and its scope,
    or hold the filler beside it back from applying on its own.
    """
    if left.applied != right.applied or left.author != right.author:
        return True
    return any(
        _is_pause(decision)
        or (
            decision.review_required
            and (policy := decision_policy(decision)) is not None
            and policy.proposal_review
        )
        for decision in (left, right)
    )


def cut_time_range(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    reason: str = NL_RANGE_REASON,
    review_required: bool = True,
    crossfade_ms: int = 10,
    use_inaudible_opt: bool | None = None,
    defaults: EffectiveConfig,
) -> EditDecision:
    return add_remove_decision(
        project,
        track_id,
        start,
        end,
        reason=reason,
        review_required=review_required,
        crossfade_ms=crossfade_ms,
        use_inaudible_opt=use_inaudible_opt,
        defaults=defaults,
    )


def cut_text_match(
    project: EpisodeProject,
    query: str,
    *,
    track_id: str | None = None,
    speaker: str | None = None,
    match_all: bool = False,
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
    defaults: EffectiveConfig,
) -> list[EditDecision]:
    matches = search_transcript(
        project, query, track_id=track_id, speaker=speaker, defaults=defaults
    )
    if not matches:
        return []
    selected = matches if match_all else [matches[0]]
    decisions: list[EditDecision] = []
    for m in selected:
        decisions.append(
            _cut_transcript_source_range(
                project,
                m.track_id,
                m.source_id,
                m.start,
                m.end,
                reason=f"{NL_MATCH_REASON_PREFIX}{query[:40]}",
                review_required=review_required,
                use_inaudible_opt=use_inaudible_opt,
                defaults=defaults,
            )
        )
    return decisions


def cut_utterance(
    project: EpisodeProject,
    utterance_index: int,
    *,
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
    defaults: EffectiveConfig,
) -> EditDecision:
    combined = ensure_combined_transcript(project, defaults=defaults)
    tid, source_id, start, end, text = time_range_from_utterance(combined, utterance_index)
    return _cut_transcript_source_range(
        project,
        tid,
        source_id,
        start,
        end,
        reason=f"{NL_UTTERANCE_REASON_PREFIX}{text[:40]}",
        review_required=review_required,
        use_inaudible_opt=use_inaudible_opt,
        defaults=defaults,
    )


def cut_words(
    project: EpisodeProject,
    track_id: str,
    start_word_index: int,
    end_word_index: int,
    *,
    source_id: str | None = None,
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
    defaults: EffectiveConfig,
) -> EditDecision:
    transcript = _cut_transcript_for_source(project, track_id, source_id)
    if not transcript:
        raise CodedValueError(
            f"No transcript for track {track_id} source {source_id}. Transcribe that track first.",
            code="transcript_not_found",
        )
    start, end = time_range_from_words(transcript, start_word_index, end_word_index)
    return _cut_transcript_source_range(
        project,
        track_id,
        source_id,
        start,
        end,
        reason=NL_WORDS_REASON,
        review_required=review_required,
        use_inaudible_opt=use_inaudible_opt,
        defaults=defaults,
    )


def _cut_transcript_source_range(
    project: EpisodeProject,
    track_id: str,
    source_id: str | None,
    start: float,
    end: float,
    *,
    reason: str,
    review_required: bool,
    use_inaudible_opt: bool | None,
    defaults: EffectiveConfig,
) -> EditDecision:
    transcript = _cut_transcript_for_source(project, track_id, source_id)
    if transcript is None and source_id is not None:
        raise CodedValueError(
            f"No transcript for track {track_id} source {source_id}. Transcribe that track first.",
            code="transcript_not_found",
        )
    return add_remove_decision(
        project,
        track_id,
        start,
        end,
        reason=reason,
        review_required=review_required,
        use_inaudible_opt=use_inaudible_opt,
        source_id=source_id,
        source_aware=True,
        defaults=defaults,
    )


def format_transcript_timestamps(project: EpisodeProject, *, defaults: EffectiveConfig) -> str:
    combined = ensure_combined_transcript(project, defaults=defaults)
    lines: list[str] = []
    for i, u in enumerate(combined.utterances):
        lines.append(f"[{i}] {u.start:.2f}-{u.end:.2f}s {u.speaker} ({u.track_id}): {u.text}")
    return "\n".join(lines)
