from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.edit_reasons import (
    GUEST_SUGGEST_SPLIT_REASON,
    NL_MANUAL_REASON,
    NL_MATCH_REASON_PREFIX,
    NL_RANGE_REASON,
    NL_UTTERANCE_REASON_PREFIX,
    NL_WORDS_REASON,
)
from podcast_mcp.edits.filler_pacing import paced_pad_for_span
from podcast_mcp.edits.inaudible_cuts import optimize_source_cut_range
from podcast_mcp.edits.tighten_reasons import is_review_only_reason
from podcast_mcp.edits.timeline_span import source_span_timeline_bounds
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    CombinedTranscript,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    Transcript,
)
from podcast_mcp.util.text import normalize_text


@dataclass
class TranscriptMatch:
    track_id: str
    start: float
    end: float
    text: str
    speaker: str | None = None
    utterance_index: int | None = None
    word_start_index: int | None = None
    word_end_index: int | None = None
    timeline_start: float | None = None
    timeline_end: float | None = None


def _timeline_span_for_source(
    project: EpisodeProject,
    track_id: str,
    src_start: float,
    src_end: float,
) -> tuple[float | None, float | None]:
    """Map a source-clock span to session timeline (None if fully cut away)."""
    return source_span_timeline_bounds(SessionTimeline(project), track_id, src_start, src_end)


def _with_timeline_spans(project: EpisodeProject, match: TranscriptMatch) -> TranscriptMatch:
    tl_start, tl_end = _timeline_span_for_source(project, match.track_id, match.start, match.end)
    if match.timeline_start is None:
        match.timeline_start = tl_start
    if match.timeline_end is None:
        match.timeline_end = tl_end
    return match


def ensure_combined_transcript(project: EpisodeProject) -> CombinedTranscript:
    if project.combined_transcript and project.combined_transcript.utterances:
        return project.combined_transcript
    from podcast_mcp.engines import TranscriptionEngine

    project.combined_transcript = TranscriptionEngine().merge_transcripts(project)
    return project.combined_transcript


def search_transcript(
    project: EpisodeProject,
    query: str,
    *,
    track_id: str | None = None,
    speaker: str | None = None,
    fuzzy: bool = True,
    include_suppressed: bool = False,
) -> list[TranscriptMatch]:
    q = normalize_text(query)
    if not q:
        return []
    matches: list[TranscriptMatch] = []
    combined = ensure_combined_transcript(project)
    for idx, utt in enumerate(combined.utterances):
        if track_id and utt.track_id != track_id:
            continue
        if speaker and normalize_text(utt.speaker) != normalize_text(speaker):
            continue
        hay = normalize_text(utt.text) if fuzzy else utt.text
        if q in hay:
            matches.append(
                _with_timeline_spans(
                    project,
                    TranscriptMatch(
                        track_id=utt.track_id,
                        start=utt.start,
                        end=utt.end,
                        text=utt.text,
                        speaker=utt.speaker,
                        utterance_index=idx,
                    ),
                )
            )

    for transcript in project.transcripts:
        if track_id and transcript.track_id != track_id:
            continue
        words = transcript.words
        if not words:
            continue
        tr = project.track_by_id(transcript.track_id)
        sp = tr.speaker if tr else transcript.track_id
        if speaker and sp and normalize_text(sp) != normalize_text(speaker):
            continue
        window = 16
        for i in range(len(words)):
            if not include_suppressed and words[i].suppressed:
                continue
            for j in range(i, min(len(words), i + window)):
                if not include_suppressed and any(w.suppressed for w in words[i : j + 1]):
                    continue
                chunk = " ".join(w.text for w in words[i : j + 1])
                hay = normalize_text(chunk) if fuzzy else chunk
                if q in hay:
                    matches.append(
                        _with_timeline_spans(
                            project,
                            TranscriptMatch(
                                track_id=transcript.track_id,
                                start=words[i].start,
                                end=words[j].end,
                                text=chunk,
                                speaker=sp,
                                word_start_index=i,
                                word_end_index=j,
                            ),
                        )
                    )
                    break
            else:
                continue
            break
    return matches


def time_range_from_words(
    transcript: Transcript,
    start_word_index: int,
    end_word_index: int,
) -> tuple[float, float]:
    words = transcript.words
    if not words:
        raise ValueError("Transcript has no words")
    start = max(0, min(start_word_index, len(words) - 1))
    end = max(start, min(end_word_index, len(words) - 1))
    return words[start].start, words[end].end


def time_range_from_utterance(
    combined: CombinedTranscript,
    utterance_index: int,
) -> tuple[str, float, float, str]:
    if utterance_index < 0 or utterance_index >= len(combined.utterances):
        raise ValueError(f"Utterance index out of range: {utterance_index}")
    utt = combined.utterances[utterance_index]
    return utt.track_id, utt.start, utt.end, utt.text


def append_remove_decision(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    reason: str = NL_MANUAL_REASON,
    review_required: bool = True,
    applied: bool = False,
    crossfade_ms: int = 10,
    cut_confidence: float | None = None,
    boundary_mode: str | None = None,
    replace_gap_sec: float | None = None,
    next_burst_sec: float | None = None,
    scope: str = "session",
    decision_type: EditDecisionType = EditDecisionType.REMOVE,
    decision_id: str | None = None,
    author: str | None = None,
) -> EditDecision:
    """Append a remove or mute decision without waveform optimization or coalescing.

    ``decision_id`` is the generator's stable hit id; omitted, the id is random.
    """
    if end <= start:
        raise ValueError("end must be greater than start")
    if decision_type not in (EditDecisionType.REMOVE, EditDecisionType.MUTE):
        raise ValueError("decision_type must be remove or mute")
    decision = EditDecision(
        id=decision_id or f"cut_{uuid.uuid4().hex[:8]}",
        track_id=track_id,
        type=decision_type,
        start=start,
        end=end,
        crossfade_ms=crossfade_ms,
        reason=reason,
        review_required=review_required,
        applied=applied,
        cut_confidence=cut_confidence,
        boundary_mode=boundary_mode,
        replace_gap_sec=replace_gap_sec,
        next_burst_sec=next_burst_sec,
        scope=scope,
        author=author,
    )
    from podcast_mcp.edits.source_removals import require_source_remove

    require_source_remove(project, decision)
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
        raise ValueError("track_ids required for split proposal")
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
    applied: bool = False,
    crossfade_ms: int = 10,
    use_inaudible_opt: bool | None = None,
    defaults: dict | None = None,
) -> EditDecision:
    if end <= start:
        raise ValueError("end must be greater than start")
    from podcast_mcp.config import load_defaults
    from podcast_mcp.edits.filler_pacing import apply_filler_pacing
    from podcast_mcp.edits.source_removals import (
        CutScopeHold,
        ScopeChangedAtApproval,
        inspect_source_remove_placement,
        require_source_remove,
    )
    from podcast_mcp.edits.speech_energy_guard import CutScopeUnavailable, resolve_cut_scope

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
        ),
    )
    if isinstance(placement, CutScopeHold):
        raise ScopeChangedAtApproval([placement], {})
    cfg = defaults if defaults is not None else load_defaults()
    # Pace from the requested span first so waveform snap cannot pull a boundary
    # onto the next word and then room-tone-expand across real dialogue.
    paced = apply_filler_pacing(
        project,
        track_id,
        start,
        end,
        defaults=cfg,
        cut_kind="nl",
    )
    if paced is None:
        raise ValueError(
            "cut would leave flanking words closer than min_gap_after_filler_sec; "
            "widen the retained gap or leave this hesitation in"
        )
    opt = optimize_source_cut_range(
        project,
        track_id,
        paced.start,
        paced.end,
        force_enabled=use_inaudible_opt,
    )
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

    replace_gap = None if paced.pad is None else paced.pad.seconds(cut_start, cut_end)
    scope = "session"
    review = review_required
    cut_reason = reason
    decision_id = f"cut_{uuid.uuid4().hex[:8]}"
    resolved = resolve_cut_scope(
        project,
        track_id,
        cut_start,
        cut_end,
        defaults=cfg,
    )
    if isinstance(resolved, CutScopeUnavailable):
        raise ScopeChangedAtApproval([CutScopeHold(decision_id, (), "scope_unavailable")], {})
    scope, guard = resolved.scope, resolved.guard
    if guard is not None and guard.action == "skip":
        from podcast_mcp.edits.speech_energy_guard import PeerSpeechBlocked

        raise PeerSpeechBlocked(guard.blocking_track_ids)
    if guard is not None and guard.blocked:
        peers = ",".join(guard.blocking_track_ids)
        if guard.action == "review":
            review = True
            cut_reason = f"{reason}:other_speaking:{peers}"
        else:
            cut_reason = f"{reason}:track_local:{peers}"
        replace_gap = None
        scope = "track"

    decision = EditDecision(
        id=decision_id,
        track_id=track_id,
        type=EditDecisionType.REMOVE,
        start=cut_start,
        end=cut_end,
        crossfade_ms=crossfade_ms,
        reason=cut_reason,
        review_required=review,
        applied=applied,
        cut_confidence=opt.confidence,
        boundary_mode=opt.mode,
        replace_gap_sec=replace_gap,
        scope=scope,
    )
    require_source_remove(project, decision)
    staged = project.model_copy(deep=True)
    staged.edit_decisions.append(decision)
    joining_ids = _joining_remove_ids(staged.edit_decisions, decision.id, merge_gap_sec=0.05)
    coalesce_edits(staged, track_id=track_id, defaults=cfg, merge_ids=joining_ids)
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
    project.edit_decisions = staged.edit_decisions
    return survivor


def _same_merge_identity(left: EditDecision, right: EditDecision) -> bool:
    return (
        left.track_id == right.track_id
        and left.type == right.type
        and left.timebase == right.timebase
        and left.scope == right.scope
        and left.author == right.author
        and left.applied == right.applied
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
    rows: Sequence[EditDecision], *, merge_gap_sec: float
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
                and _same_merge_identity(hull, row)
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
    rows: Sequence[EditDecision], new_id: str, *, merge_gap_sec: float
) -> set[str]:
    for group in _merge_groups(rows, merge_gap_sec=merge_gap_sec):
        if any(row.id == new_id for row in group):
            return {row.id for row in group}
    raise RuntimeError("source remove has no coalescing group")


def coalesce_edits(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    merge_gap_sec: float = 0.05,
    defaults: dict[str, Any] | None = None,
    skip_counts: dict[str, int] | None = None,
    merge_ids: set[str] | None = None,
) -> int:
    """Merge overlapping/adjacent same-track REMOVE/MUTE decisions with matching boundary modes.

    A merged cut that any padded cut went into is padded again from the merged span
    (``defaults`` supplies the pacing rule; see :func:`_merged_pad_sec`).
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
    from podcast_mcp.edits.source_removals import (
        CutScopeHold,
        inspect_source_remove,
        require_source_remove,
    )

    for rows in _merge_groups(owned, merge_gap_sec=merge_gap_sec):
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
            survivor.replace_gap_sec = _merged_pad_sec(project, group, defaults)
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
        result.append(survivor)
    project.edit_decisions = result
    return merged_count


def _merged_pad_sec(
    project: EpisodeProject, group: list[EditDecision], defaults: dict[str, Any] | None
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
        paced = paced_pad_for_span(project, top.track_id, top.start, top.end, defaults)
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
        _is_pause(decision) or (decision.review_required and is_review_only_reason(decision.reason))
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
    defaults: dict | None = None,
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
) -> list[EditDecision]:
    matches = search_transcript(project, query, track_id=track_id, speaker=speaker)
    if not matches:
        return []
    selected = matches if match_all else [matches[0]]
    decisions: list[EditDecision] = []
    for m in selected:
        decisions.append(
            cut_time_range(
                project,
                m.track_id,
                m.start,
                m.end,
                reason=f"{NL_MATCH_REASON_PREFIX}{query[:40]}",
                review_required=review_required,
                use_inaudible_opt=use_inaudible_opt,
            )
        )
    return decisions


def cut_utterance(
    project: EpisodeProject,
    utterance_index: int,
    *,
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
) -> EditDecision:
    combined = ensure_combined_transcript(project)
    tid, start, end, text = time_range_from_utterance(combined, utterance_index)
    return cut_time_range(
        project,
        tid,
        start,
        end,
        reason=f"{NL_UTTERANCE_REASON_PREFIX}{text[:40]}",
        review_required=review_required,
        use_inaudible_opt=use_inaudible_opt,
    )


def cut_words(
    project: EpisodeProject,
    track_id: str,
    start_word_index: int,
    end_word_index: int,
    *,
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
) -> EditDecision:
    transcript = project.transcript_for_track(track_id)
    if not transcript:
        raise ValueError(f"No transcript for track {track_id}")
    start, end = time_range_from_words(transcript, start_word_index, end_word_index)
    return cut_time_range(
        project,
        track_id,
        start,
        end,
        reason=NL_WORDS_REASON,
        review_required=review_required,
        use_inaudible_opt=use_inaudible_opt,
    )


def apply_edit_plan(
    project: EpisodeProject,
    edits: list[dict[str, Any]],
    *,
    crossfade_ms: int = 10,
    review_required: bool = True,
    use_inaudible_opt: bool | None = None,
) -> list[EditDecision]:
    created: list[EditDecision] = []
    for raw in edits:
        created.append(
            add_remove_decision(
                project,
                str(raw["track_id"]),
                float(raw["start"]),
                float(raw["end"]),
                reason=str(raw.get("reason", "agent:plan")),
                review_required=bool(raw.get("review_required", review_required)),
                applied=bool(raw.get("applied", False)),
                crossfade_ms=int(raw.get("crossfade_ms", crossfade_ms)),
                use_inaudible_opt=raw.get("use_inaudible_opt", use_inaudible_opt),
            )
        )
    return created


def format_transcript_timestamps(project: EpisodeProject) -> str:
    combined = ensure_combined_transcript(project)
    lines: list[str] = []
    for i, u in enumerate(combined.utterances):
        lines.append(f"[{i}] {u.start:.2f}-{u.end:.2f}s {u.speaker} ({u.track_id}): {u.text}")
    return "\n".join(lines)
