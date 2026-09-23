from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.inaudible_cuts import optimize_source_cut_range
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import (
    CombinedTranscript,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    Transcript,
)
from podcast_mcp.util.text import normalize_text
from podcast_mcp.util.timebase import SourceSec


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
    spans = SessionTimeline(project).map_source_span(
        track_id, SourceSec(src_start), SourceSec(src_end)
    )
    if not spans:
        return None, None
    return float(spans[0][0]), float(spans[-1][1])


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
    reason: str = "nl:manual",
    review_required: bool = True,
    applied: bool = False,
    crossfade_ms: int = 10,
    cut_confidence: float | None = None,
    boundary_mode: str | None = None,
    replace_gap_sec: float | None = None,
    scope: str = "session",
    decision_type: EditDecisionType = EditDecisionType.REMOVE,
) -> EditDecision:
    """Append a remove or mute decision without waveform optimization or coalescing."""
    if end <= start:
        raise ValueError("end must be greater than start")
    if decision_type not in (EditDecisionType.REMOVE, EditDecisionType.MUTE):
        raise ValueError("decision_type must be remove or mute")
    decision = EditDecision(
        id=f"cut_{uuid.uuid4().hex[:8]}",
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
        scope=scope,
    )
    project.edit_decisions.append(decision)
    return decision


def append_split_decision(
    project: EpisodeProject,
    at_time: float,
    track_ids: list[str],
    *,
    reason: str = "guest:suggest_split",
    review_required: bool = True,
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
    )
    project.edit_decisions.append(decision)
    return decision


def add_remove_decision(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    reason: str = "nl:manual",
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
    from podcast_mcp.edits.speech_energy_guard import resolve_cut_scope

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
    if paced.replace_gap_sec is not None:
        cut_start = min(max(cut_start, paced.start), paced.end)
        if paced.allow_trailing_past_end and opt.details.get("trailing_energy_extended"):
            cut_end = max(cut_end, cut_start + 0.001)
        else:
            cut_end = max(min(cut_end, paced.end), cut_start)
    if cut_end <= cut_start:
        cut_start, cut_end = paced.start, paced.end

    replace_gap = paced.replace_gap_sec
    scope = "session"
    review = review_required
    cut_reason = reason
    try:
        scope, guard = resolve_cut_scope(
            project,
            track_id,
            cut_start,
            cut_end,
            defaults=cfg,
        )
    except ValueError:
        raise
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
        id=f"cut_{uuid.uuid4().hex[:8]}",
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
    project.edit_decisions.append(decision)
    coalesce_edits(project, track_id=track_id)
    return decision


def coalesce_edits(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    merge_gap_sec: float = 0.05,
) -> int:
    """Merge overlapping or adjacent REMOVE/MUTE decisions on the same track."""
    mergeable = (EditDecisionType.REMOVE, EditDecisionType.MUTE)
    by_key: dict[tuple[str, EditDecisionType], list[EditDecision]] = {}
    other: list[EditDecision] = []
    for e in project.edit_decisions:
        if e.type not in mergeable:
            other.append(e)
            continue
        if track_id and e.track_id != track_id:
            other.append(e)
            continue
        by_key.setdefault((e.track_id, e.type), []).append(e)

    merged_count = 0
    result: list[EditDecision] = list(other)
    for _key, edits in by_key.items():
        edits.sort(key=lambda x: x.start)
        if not edits:
            continue
        stack = [edits[0]]
        for e in edits[1:]:
            top = stack[-1]
            if e.start <= top.end + merge_gap_sec and not _keeps_independent_review(top, e):
                top.end = max(top.end, e.end)
                if e.review_required:
                    top.review_required = True
                if e.replace_gap_sec is not None:
                    top.replace_gap_sec = max(top.replace_gap_sec or 0.0, e.replace_gap_sec)
                merged_count += 1
            else:
                stack.append(e)
        result.extend(stack)
    project.edit_decisions = result
    return merged_count


def _keeps_independent_review(left: EditDecision, right: EditDecision) -> bool:
    """Keep generated repeat/restart proposals individually reviewable.

    Their reason and id identify a specific linguistic repair.  A neighboring
    filler or pause can be safely coalesced with ordinary cuts, but merging it
    into one of these proposals loses that review context.
    """
    return any(
        decision.review_required and (decision.reason or "").startswith(("repetition:", "restart:"))
        for decision in (left, right)
    )


def cut_time_range(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    reason: str = "nl:range",
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
                reason=f"nl:match:{query[:40]}",
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
        reason=f"nl:utterance:{text[:40]}",
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
        reason="nl:words",
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
