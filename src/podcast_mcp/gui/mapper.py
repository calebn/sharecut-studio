from __future__ import annotations

from typing import Any

from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.pending_preview import preview_window_for_edit
from podcast_mcp.edits.timeline_span import map_source_span_fields
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import AppliedEditRecord, EditDecision, EpisodeProject

TIGHTEN_REASON_PREFIXES = ("filler:", "pause:", "repetition:", "restart:")


def is_tighten_reason(reason: str | None) -> bool:
    """True for pending tighten proposals."""
    text = reason or ""
    return text.startswith(TIGHTEN_REASON_PREFIXES)


def join_risk_from_decision(decision: EditDecision) -> dict[str, Any] | None:
    """View-only join risk from propose-time flags (no audio / no join sweep).

    ``EditService.join_quality`` is available per decision (MCP/CLI). The
    assembler does not score every snapshot — fail verdicts are already
    dropped when ``tighten.join_continuity_gate`` is on; review/risky stay
    on the decision as ``:join_review`` / ``:risky`` / ``review_required``.
    """
    reason = decision.reason or ""
    if not is_tighten_reason(reason):
        return None
    if ":risky" in reason:
        return {"verdict": "review", "label": "risky", "source": "reason", "risk": None}
    if ":join_review" in reason:
        return {
            "verdict": "review",
            "label": "join_review",
            "source": "reason",
            "risk": None,
        }
    return None


def map_pending_edits_to_timeline(
    project: EpisodeProject,
    decisions: list[EditDecision],
) -> list[dict[str, Any]]:
    """Map pending edit decisions from source clock to timeline intervals."""
    timeline = SessionTimeline(project)
    rows: list[dict[str, Any]] = []
    for decision in decisions:
        type_val = decision.type.value if hasattr(decision.type, "value") else str(decision.type)
        track_ids = list(decision.track_ids) if decision.track_ids else [decision.track_id]
        timeline_start: float | None
        timeline_end: float | None
        if type_val == "split" or decision.timebase == "timeline":
            at = float(decision.start)
            mappable = True
            timeline_start = at
            timeline_end = float(decision.end)
            if abs(timeline_end - timeline_start) < 1e-9:
                # Zero-width blade marker - give overlay a visible 1-frame span.
                timeline_end = at
            timeline_spans = [{"start": timeline_start, "end": max(timeline_end, at)}]
            source_start = at
            source_end = at
        else:
            mappable, timeline_spans, timeline_start, timeline_end = map_source_span_fields(
                timeline, decision.track_id, decision.start, decision.end
            )
            source_start = decision.start
            source_end = decision.end
        preview = preview_window_for_edit(project, decision)
        rows.append(
            {
                "id": decision.id,
                "track_id": decision.track_id,
                "track_ids": track_ids,
                "type": type_val,
                "reason": decision.reason,
                "source_start": source_start,
                "source_end": source_end,
                "timeline_start": timeline_start,
                "timeline_end": timeline_end,
                "timeline_spans": timeline_spans,
                "mappable": mappable,
                "can_skip": preview.can_skip,
                "skip_reason": preview.skip_reason,
                "crossfade_ms": decision.crossfade_ms,
                "boundary_mode": decision.boundary_mode,
                "cut_confidence": decision.cut_confidence,
                "review_required": decision.review_required,
                "applied": decision.applied,
                "timebase": decision.timebase,
                "scope": decision.scope,
                "join_risk": join_risk_from_decision(decision),
            }
        )
    return rows


def _words_for_utterance(
    project: EpisodeProject,
    timeline: SessionTimeline,
    track_id: str,
    source_start: float,
    source_end: float,
) -> list[dict[str, Any]]:
    """Per-track words overlapping the utterance, including suppressed chips."""
    tr = project.transcript_for_track(track_id)
    if tr is None:
        return []
    words: list[dict[str, Any]] = []
    for word_index, word in enumerate(tr.words):
        if word.end <= word.start:
            if not (source_start <= word.start < source_end):
                continue
        else:
            if word.end <= source_start or word.start >= source_end:
                continue
        words.append(_word_view(timeline, track_id, word_index, word))
    return words


def _word_view(
    timeline: SessionTimeline,
    track_id: str,
    word_index: int,
    word: Any,
) -> dict[str, Any]:
    src_end = float(word.start) + 0.001 if word.end <= word.start else float(word.end)
    mappable, _spans, tl_start, tl_end = map_source_span_fields(
        timeline, track_id, float(word.start), src_end
    )
    return {
        "text": word.text,
        "start": float(word.start),
        "end": float(word.end),
        "timeline_start": tl_start,
        "timeline_end": tl_end,
        "mappable": mappable,
        "word_index": word_index,
        "confidence": word.confidence,
        "suppressed": bool(word.suppressed),
    }


def omit_transcript_words(transcript: dict[str, Any] | None) -> dict[str, Any] | None:
    """Drop per-word timings from a combined-transcript dict (shell / guest size)."""
    if transcript is None:
        return None
    utterances = transcript.get("utterances")
    if not isinstance(utterances, list):
        return transcript
    slim: list[dict[str, Any]] = []
    for utterance in utterances:
        if not isinstance(utterance, dict):
            continue
        row = dict(utterance)
        row.pop("words", None)
        slim.append(row)
    return {**transcript, "utterances": slim}


def map_transcript_utterances_to_timeline(
    project: EpisodeProject,
    transcript: dict[str, Any] | None,
    *,
    include_words: bool = True,
) -> dict[str, Any] | None:
    """Attach timeline clocks (+ optional word timings) to combined transcript utterances."""
    if transcript is None:
        return None
    utterances = transcript.get("utterances")
    if not isinstance(utterances, list):
        return transcript
    timeline = SessionTimeline(project)
    mapped: list[dict[str, Any]] = []
    for utterance in utterances:
        if not isinstance(utterance, dict):
            continue
        track_id = str(utterance.get("track_id", ""))
        source_start = float(utterance.get("start", 0.0))
        source_end = float(utterance.get("end", 0.0))
        mappable, timeline_spans, timeline_start, timeline_end = map_source_span_fields(
            timeline, track_id, source_start, source_end
        )
        row: dict[str, Any] = {
            **utterance,
            "start": source_start,
            "end": source_end,
            "timeline_start": timeline_start,
            "timeline_end": timeline_end,
            "timeline_spans": timeline_spans,
            "mappable": mappable,
        }
        row.pop("words", None)
        if include_words:
            row["words"] = _words_for_utterance(
                project, timeline, track_id, source_start, source_end
            )
        mapped.append(row)
    return {**transcript, "utterances": mapped}


def map_applied_edits_to_timeline(
    project: EpisodeProject,
    applied: dict[str, Any] | list[AppliedEditRecord],
) -> dict[str, Any]:
    """Fill missing timeline_* on applied-edit records for the GUI view.

    Legacy edit_log rows may only have source clocks. Mapping is view-only -
    does not mutate ``editorial.edit_log`` on disk.
    """
    records_in = applied.get("records", []) if isinstance(applied, dict) else list(applied)

    timeline = SessionTimeline(project)
    records: list[dict[str, Any]] = []
    for raw in records_in:
        if isinstance(raw, AppliedEditRecord):
            row = raw.model_dump()
        elif isinstance(raw, dict):
            row = dict(raw)
        else:
            continue

        tl_start = row.get("timeline_start")
        tl_end = row.get("timeline_end")
        src_start = row.get("source_start")
        src_end = row.get("source_end")
        track_ids = row.get("track_ids") or []
        needs_map = (
            (tl_start is None or tl_end is None)
            and src_start is not None
            and src_end is not None
            and bool(track_ids)
        )
        if needs_map:
            assert src_start is not None and src_end is not None
            mappable, _spans, mapped_start, mapped_end = map_source_span_fields(
                timeline,
                str(track_ids[0]),
                float(src_start),
                float(src_end),
            )
            if mappable:
                row["timeline_start"] = mapped_start
                row["timeline_end"] = mapped_end
        records.append(row)

    return {"count": len(records), "records": records}


def map_edit_boundaries(project: EpisodeProject) -> list[dict[str, Any]]:
    """Derive join/cutaway edit boundaries from abutting clips + transcript words."""
    rows: list[dict[str, Any]] = []
    track_ids = sorted({c.track_id for c in project.clips})
    for track_id in track_ids:
        clips = clips_for_track(project, track_id)
        tr = project.transcript_for_track(track_id)
        for i, left in enumerate(clips):
            if i + 1 >= len(clips):
                continue
            right = clips[i + 1]
            cutaway_start = float(left.source_end)
            cutaway_end = float(right.source_start)
            if cutaway_end < cutaway_start:
                cutaway_end = cutaway_start
            cutaway_word_ids: list[dict[str, Any]] = []
            if tr is not None and cutaway_end > cutaway_start + 1e-9:
                for word_index, word in enumerate(tr.words):
                    w_end = float(word.start) + 0.001 if word.end <= word.start else float(word.end)
                    if w_end <= cutaway_start or float(word.start) >= cutaway_end:
                        continue
                    cutaway_word_ids.append(
                        {
                            "track_id": track_id,
                            "word_index": word_index,
                            "text": word.text,
                            "start": float(word.start),
                            "end": float(word.end),
                        }
                    )
            rows.append(
                {
                    "id": f"eb:{left.id}:{right.id}",
                    "track_id": track_id,
                    "left_clip_id": left.id,
                    "right_clip_id": right.id,
                    "timeline_join_sec": float(left.timeline_end),
                    "cutaway_source_start": cutaway_start,
                    "cutaway_source_end": cutaway_end,
                    "has_cutaway": cutaway_end > cutaway_start + 1e-9,
                    "cutaway_word_ids": cutaway_word_ids,
                }
            )
    return rows


def social_clips_for_view(project: EpisodeProject) -> list[dict[str, Any]]:
    """Serialize social clip candidates (already on the timeline clock)."""
    rows: list[dict[str, Any]] = []
    for candidate in project.social.clip_candidates:
        rows.append(
            {
                "id": candidate.id,
                "track_id": candidate.track_id,
                "start": candidate.start,
                "end": candidate.end,
                "score": candidate.score,
                "title_suggestion": candidate.title_suggestion,
                "approved": candidate.approved,
                "review_required": candidate.review_required,
            }
        )
    return rows
