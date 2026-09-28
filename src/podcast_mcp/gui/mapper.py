from __future__ import annotations

import heapq
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.clips_ops import clips_for_track
from podcast_mcp.edits.pending_preview import preview_window_for_edit
from podcast_mcp.edits.timeline_span import map_source_span_fields
from podcast_mcp.engines.session_timeline import SessionTimeline, word_source_span
from podcast_mcp.engines.utterance_runs import utterance_runs, utterance_speaker, utterance_text
from podcast_mcp.models import AppliedEditRecord, Clip, EditDecision, EpisodeProject
from podcast_mcp.util.intervals import HalfOpenIntervalIndex

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


@dataclass(frozen=True)
class _MappedWordIndex:
    intervals: HalfOpenIntervalIndex
    words: list[Any]
    views: list[dict[str, Any]]


def _raw_word_intervals(words: Sequence[Any]) -> HalfOpenIntervalIndex:
    """Source-clock overlap index over a track's raw words (zero-length words padded).

    Pure: never maps words onto the timeline (``SessionTimeline.map_word_spans``).
    """
    return HalfOpenIntervalIndex.build(word_source_span(w.start, w.end) for w in words)


def _mapped_word_index(
    project: EpisodeProject, timeline: SessionTimeline, track_id: str
) -> _MappedWordIndex:
    tr = project.transcript_for_track(track_id)
    words = tr.words if tr is not None else []
    mapped = timeline.map_word_spans(track_id, [(w.start, w.end) for w in words])
    views = [
        _word_view(timeline, track_id, i, w, spans)
        for i, (w, spans) in enumerate(zip(words, mapped, strict=True))
    ]
    intervals = _raw_word_intervals(words)
    return _MappedWordIndex(intervals, words, views)


def _word_in_utterance(word: Any, source_start: float, source_end: float) -> bool:
    """Whether ``word`` (source-media seconds) overlaps ``[source_start, source_end)``."""
    if word.end <= word.start:
        return source_start <= word.start < source_end
    return not (word.end <= source_start or word.start >= source_end)


def _covered_word_ordinals(
    words: Sequence[Any],
    intervals: HalfOpenIntervalIndex,
    source_start: float,
    source_end: float,
) -> set[int]:
    """Per-track word indices an utterance's own source window covers (#752).

    The one coverage predicate shared by the row's word listing, its
    ``ignored_word_indices`` and the edge-suppressed coverage check, so they
    cannot disagree. A zero-length window (``merge_transcripts`` emits one for a
    lone zero-duration word) is padded like a zero-length word
    (``word_source_span``), so it covers its own word and any word straddling it.
    """
    start, end = word_source_span(source_start, source_end)
    return {
        word_index
        for word_index in intervals.overlapping_ordinals(start, end)
        if _word_in_utterance(words[word_index], start, end)
    }


def _words_for_utterance(
    project: EpisodeProject,
    timeline: SessionTimeline,
    track_id: str,
    source_start: float,
    source_end: float,
    index: _MappedWordIndex | None = None,
    *,
    extra_indices: Sequence[int] = (),
) -> list[dict[str, Any]]:
    """Per-track words overlapping the utterance, including suppressed chips.

    ``extra_indices`` adds edge-suppressed words this utterance owns per
    ``_edge_suppressed_word_indices`` — words outside this utterance's own
    ``[source_start, source_end)`` window on this track (#752).
    """
    index = index if index is not None else _mapped_word_index(project, timeline, track_id)
    selected = _covered_word_ordinals(index.words, index.intervals, source_start, source_end)
    selected.update(extra_indices)
    return [index.views[i] for i in sorted(selected)]


def _ignored_word_indices_for_utterance(
    words: Sequence[Any],
    intervals: HalfOpenIntervalIndex,
    source_start: float,
    source_end: float,
    *,
    extra_indices: Sequence[int] = (),
) -> list[int]:
    """Sorted per-track `word_index` values of ignored words overlapping the utterance (#633).

    Takes the track's raw (unmapped) words and their ``_raw_word_intervals``
    index, so each utterance visits only the words near its window and never
    triggers a timeline word mapping (``SessionTimeline.map_word_spans``) —
    that stays reserved for ``include_words=True``. ``extra_indices`` folds in
    the edge-suppressed words attached to this utterance that are also
    ignored (#752).
    """
    selected = {
        index
        for index in _covered_word_ordinals(words, intervals, source_start, source_end)
        if bool(getattr(words[index], "ignored", False))
    }
    selected.update(
        index
        for index in extra_indices
        if index < len(words) and bool(getattr(words[index], "ignored", False))
    )
    return sorted(selected)


def _source_gap(word: Any, span: tuple[float, float]) -> float:
    """Source-time gap between ``word`` and an utterance window it lies outside."""
    return max(span[0] - float(word.end), float(word.start) - span[1])


def _edge_suppressed_word_indices(
    utterances: Sequence[dict[str, Any]],
    words_by_track: Mapping[str, Sequence[Any]],
    intervals_by_track: Mapping[str, HalfOpenIntervalIndex] | None = None,
) -> dict[int, list[int]]:
    """Attach edge-suppressed words to their nearest same-track utterance (#752).

    A suppressed word that falls outside every same-track utterance
    ``[start, end)`` window — an utterance's first or last word, or a
    suppressed run between two utterances — is attached to exactly one
    utterance: the nearest by source-time gap, ties going to the earlier
    utterance. Words already covered by any same-track utterance's own
    window, per ``_covered_word_ordinals`` (the same predicate the row's word
    listing uses, with a zero-length window padded like a zero-length word),
    are left alone, because attaching them again would duplicate the chip. A
    track whose words are all suppressed has no utterance to attach to,
    so it is skipped here; `_suppressed_only_rows` lists those words instead
    (#758).

    Neighbours come from a ``HalfOpenIntervalIndex`` over each track's
    utterance windows; a zero-length window is padded like a zero-length word
    so it stays a candidate. The previous/next pick by start assumes
    same-track windows never overlap, which ``merge_transcripts`` guarantees
    by construction (a new utterance starts only after a gap above its
    threshold). Were two windows to overlap, a word could attach to a
    farther-than-nearest utterance, but coverage is checked against every
    same-track window, so a chip is never duplicated.

    ``intervals_by_track`` reuses each track's ``_raw_word_intervals`` index
    when the caller already built it; it is built here otherwise.

    Returns a mapping of utterance position (index into ``utterances``) to
    the ascending per-track word indices it owns.
    """
    positions_by_track: dict[str, list[int]] = {}
    for position, utterance in enumerate(utterances):
        track_id = str(utterance.get("track_id", ""))
        positions_by_track.setdefault(track_id, []).append(position)

    result: dict[int, list[int]] = {}
    for track_id, words in words_by_track.items():
        positions = positions_by_track.get(track_id)
        if not positions:
            continue
        spans = [
            (
                float(utterances[position].get("start", 0.0)),
                float(utterances[position].get("end", 0.0)),
            )
            for position in positions
        ]
        index = HalfOpenIntervalIndex.build(word_source_span(start, end) for start, end in spans)
        word_intervals = (
            intervals_by_track[track_id]
            if intervals_by_track is not None and track_id in intervals_by_track
            else _raw_word_intervals(words)
        )
        covered: set[int] = set()
        for start, end in spans:
            covered.update(_covered_word_ordinals(words, word_intervals, start, end))
        for word_index, word in enumerate(words):
            if word_index in covered or not bool(getattr(word, "suppressed", False)):
                continue
            rank = index.start_rank(float(word.start))
            # (previous, next) neighbours by start; min() keeps the earlier on a tie.
            neighbours = index.ordinals[max(rank - 1, 0) : rank + 1]
            gaps = {ordinal: _source_gap(word, spans[ordinal]) for ordinal in neighbours}
            target = min(neighbours, key=gaps.__getitem__)
            result.setdefault(positions[target], []).append(word_index)
    return result


def _suppressed_only_rows(
    project: EpisodeProject,
    timeline: SessionTimeline,
    tracks_with_rows: set[str],
    word_indexes: dict[str, _MappedWordIndex],
    *,
    include_words: bool,
) -> list[dict[str, Any]]:
    """View-only rows for a track whose words are all suppressed (#758).

    A track whose combined transcript produced no utterance — every word is
    suppressed — still has words a user may want to Correct → Unsuppress.
    This lists them on synthetic rows instead of leaving them unreachable.
    There is one row per gap-run (the same 0.8 s split ``merge_transcripts``
    uses, ``engines/utterance_runs.py``), so each word appears on exactly one
    row and a bleed track's words spread across the episode rather than
    landing in one giant turn. ``text`` is the run's joined word text (the
    same format a real combined utterance would carry), which keeps the
    SHELL overlay's text guard meaningful for these rows too. A track with
    any unsuppressed word, or one that already has a row in the input
    combined transcript, gets no synthetic rows — that combined transcript
    is either accurate or (if a word is unsuppressed with no row) stale, and
    this function does not try to repair it. ``combined.json`` /
    ``merge_transcripts`` output is unchanged; these rows exist only in the
    GUI view.
    """
    rows: list[dict[str, Any]] = []
    for track_id in dict.fromkeys(t.track_id for t in project.transcripts):
        if track_id in tracks_with_rows:
            continue
        transcript = project.transcript_for_track(track_id)
        words = transcript.words if transcript is not None else []
        if not words or not all(bool(w.suppressed) for w in words):
            continue
        speaker = utterance_speaker(project, track_id)
        for run in utterance_runs(words):
            run_words = words[run.start : run.stop]
            row = _mapped_row(
                timeline,
                {
                    "track_id": track_id,
                    "speaker": speaker,
                    "start": float(run_words[0].start),
                    "end": float(run_words[-1].end),
                    "text": utterance_text(run_words),
                },
            )
            row["suppressed_only"] = True
            if include_words:
                if track_id not in word_indexes:
                    word_indexes[track_id] = _mapped_word_index(project, timeline, track_id)
                views = word_indexes[track_id].views
                row["words"] = [views[i] for i in run]
            ignored = [i for i in run if bool(getattr(words[i], "ignored", False))]
            if ignored:
                row["ignored_word_indices"] = ignored
            rows.append(row)
    return rows


def _word_view(
    timeline: SessionTimeline,
    track_id: str,
    word_index: int,
    word: Any,
    spans: list[tuple[Any, Any]] | None = None,
) -> dict[str, Any]:
    src_end = float(word_source_span(word.start, word.end)[1])
    if spans is None:
        mappable, _spans, tl_start, tl_end = map_source_span_fields(
            timeline, track_id, float(word.start), src_end
        )
    else:
        mappable = bool(spans)
        tl_start = float(spans[0][0]) if spans else None
        tl_end = float(spans[-1][1]) if spans else None
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
        "ignored": bool(word.ignored),
        "suspect_hallucination": bool(word.suspect_hallucination),
    }


def omit_transcript_words(transcript: dict[str, Any] | None) -> dict[str, Any] | None:
    """Drop per-word timings, and view-only ``suppressed_only`` rows (#758), from a
    combined-transcript dict for guests. A suppressed-only row's text is suppressed
    words, which guests never see.
    """
    if transcript is None:
        return None
    utterances = transcript.get("utterances")
    if not isinstance(utterances, list):
        return transcript
    slim: list[dict[str, Any]] = []
    for utterance in utterances:
        if not isinstance(utterance, dict):
            continue
        if utterance.get("suppressed_only"):
            continue
        row = dict(utterance)
        row.pop("words", None)
        slim.append(row)
    return {**transcript, "utterances": slim}


def _mapped_row(timeline: SessionTimeline, utterance: Mapping[str, Any]) -> dict[str, Any]:
    """Utterance row with timeline clocks, ``words`` dropped (padded like a zero-length word, #752)."""
    track_id = str(utterance.get("track_id", ""))
    source_start = float(utterance.get("start", 0.0))
    source_end = float(utterance.get("end", 0.0))
    mappable, timeline_spans, timeline_start, timeline_end = map_source_span_fields(
        timeline, track_id, *word_source_span(source_start, source_end)
    )
    row: dict[str, Any] = {
        **utterance,
        "track_id": track_id,
        "start": source_start,
        "end": source_end,
        "timeline_start": timeline_start,
        "timeline_end": timeline_end,
        "timeline_spans": timeline_spans,
        "mappable": mappable,
    }
    row.pop("words", None)
    return row


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
    rows: list[dict[str, Any]] = []
    raw_words_by_track: dict[str, list[Any]] = {}
    raw_intervals_by_track: dict[str, HalfOpenIntervalIndex] = {}
    for utterance in utterances:
        if not isinstance(utterance, dict):
            continue
        row = _mapped_row(timeline, utterance)
        track_id = row["track_id"]
        if track_id not in raw_words_by_track:
            tr = project.transcript_for_track(track_id)
            raw_words_by_track[track_id] = list(tr.words) if tr is not None else []
            raw_intervals_by_track[track_id] = _raw_word_intervals(raw_words_by_track[track_id])
        rows.append(row)

    edge_suppressed = _edge_suppressed_word_indices(
        rows, raw_words_by_track, raw_intervals_by_track
    )

    mapped: list[dict[str, Any]] = []
    word_indexes: dict[str, _MappedWordIndex] = {}
    for position, row in enumerate(rows):
        track_id = row["track_id"]
        source_start = row["start"]
        source_end = row["end"]
        extra_indices = edge_suppressed.get(position, [])
        if extra_indices:
            row["edge_suppressed_word_indices"] = sorted(extra_indices)
        if include_words:
            if track_id not in word_indexes:
                word_indexes[track_id] = _mapped_word_index(project, timeline, track_id)
            row["words"] = _words_for_utterance(
                project,
                timeline,
                track_id,
                source_start,
                source_end,
                word_indexes[track_id],
                extra_indices=extra_indices,
            )
        ignored_word_indices = _ignored_word_indices_for_utterance(
            raw_words_by_track[track_id],
            raw_intervals_by_track[track_id],
            source_start,
            source_end,
            extra_indices=extra_indices,
        )
        if ignored_word_indices:
            row["ignored_word_indices"] = ignored_word_indices
        mapped.append(row)

    synthetic = _suppressed_only_rows(
        project,
        timeline,
        {row["track_id"] for row in rows},
        word_indexes,
        include_words=include_words,
    )
    if synthetic:
        # Stable merge by source start: input rows keep their order and win ties.
        mapped = list(heapq.merge(mapped, synthetic, key=lambda row: row["start"]))
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


def _spans_overlap_clip(spans: list[tuple[Any, Any]], clip: Clip) -> bool:
    """True when any mapped timeline span overlaps ``clip``'s timeline range."""
    clip_start = float(clip.timeline_start)
    clip_end = float(clip.timeline_end)
    return any(float(s) < clip_end and float(e) > clip_start for s, e in spans)


def map_edit_boundaries(project: EpisodeProject) -> list[dict[str, Any]]:
    """Derive edit boundaries from neighbouring clips + transcript words.

    Every neighbouring clip pair on a track is an edit point, whether the clips
    abut (see ``clips_abut``) or a timeline gap separates them, so the transcript
    marks each one. The row is keyed on the pair, not on the join tolerance.
    """
    rows: list[dict[str, Any]] = []
    timeline = SessionTimeline(project)
    track_ids = sorted({c.track_id for c in project.clips})
    for track_id in track_ids:
        clips = clips_for_track(project, track_id)
        tr = project.transcript_for_track(track_id)
        word_spans = (
            timeline.map_word_spans(track_id, [(w.start, w.end) for w in tr.words])
            if tr is not None and len(clips) > 1
            else []
        )
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
                    w_end = float(word_source_span(word.start, word.end)[1])
                    if w_end <= cutaway_start or float(word.start) >= cutaway_end:
                        continue
                    if word.end <= word.start and _spans_overlap_clip(word_spans[word_index], left):
                        continue  # the timeline maps it onto the left clip (#621)
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
