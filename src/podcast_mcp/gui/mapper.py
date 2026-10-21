from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.cut_policy import decision_policy
from podcast_mcp.edits.pending_preview import preview_window_for_edit
from podcast_mcp.edits.tighten_hits import (
    is_harsh_tighten_hit,
    is_listen_one_by_one_hit,
    join_risk_from_decision,
)
from podcast_mcp.edits.timeline_span import (
    map_source_span_fields,
    source_remove_timeline_spans,
    timeline_span_dicts,
)
from podcast_mcp.engines.clips_ops import clips_for_track
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    origin_resolver,
    word_source_span,
)
from podcast_mcp.engines.utterance_runs import (
    utterance_runs,
    utterance_speaker,
    utterance_text,
)
from podcast_mcp.models import (
    AppliedEditRecord,
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    Transcript,
)
from podcast_mcp.util.intervals import HalfOpenIntervalIndex
from podcast_mcp.util.timebase import SourceSec, TimelineSec


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
        source_start_timeline: float | None
        source_end_timeline: float | None
        if decision.exact_range is not None:
            from podcast_mcp.edits.range_target import range_is_current

            target = decision.exact_range
            track_ids = target.track_ids
            timeline_spans = [r.model_dump() for r in target.intervals]
            timeline_start, timeline_end = target.intervals[0].start, target.intervals[-1].end
            source_start = source_end = None
            source_start_timeline = source_end_timeline = None
            mappable = range_is_current(project, target)
        elif type_val == "split" or decision.timebase == "timeline":
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
            source_start_timeline = None
            source_end_timeline = None
        else:
            source_scoped = (
                type_val == EditDecisionType.REMOVE.value
                and decision.timebase == "source"
                and (decision.source_id is not None or decision.source_timeline_span is not None)
            )
            if source_scoped:
                projected = source_remove_timeline_spans(project, decision)
                timeline_spans = projected or []
                mappable = projected is not None
                timeline_start = timeline_spans[0]["start"] if timeline_spans else None
                timeline_end = timeline_spans[-1]["end"] if timeline_spans else None
            else:
                mappable, timeline_spans, timeline_start, timeline_end = map_source_span_fields(
                    timeline, decision.track_id, decision.start, decision.end
                )
            source_start = decision.start
            source_end = decision.end
            if source_scoped:
                source_start_timeline = timeline_start
                source_end_timeline = timeline_end
            else:
                start_point = timeline.source_to_timeline(
                    decision.track_id, SourceSec(float(source_start))
                )
                end_point = timeline.source_to_timeline(
                    decision.track_id, SourceSec(float(source_end))
                )
                source_start_timeline = float(start_point) if start_point is not None else None
                source_end_timeline = float(end_point) if end_point is not None else None
        preview = preview_window_for_edit(project, decision)
        sound_info = decision_policy(decision)
        rows.append(
            {
                "exact_range": decision.exact_range.model_dump(mode="json")
                if decision.exact_range
                else None,
                "id": decision.id,
                "author": decision.author,
                "track_id": decision.track_id,
                "track_ids": track_ids,
                "type": type_val,
                "reason": decision.reason,
                "source_start": source_start,
                "source_end": source_end,
                "timeline_start": timeline_start,
                "timeline_end": timeline_end,
                "source_start_timeline": source_start_timeline,
                "source_end_timeline": source_end_timeline,
                "timeline_spans": timeline_spans,
                "mappable": mappable,
                "suggest_reason": preview.suggest_reason,
                "crossfade_ms": decision.crossfade_ms,
                "boundary_mode": decision.boundary_mode,
                "cut_confidence": decision.cut_confidence,
                "review_required": decision.review_required,
                "applied": decision.applied,
                "timebase": decision.timebase,
                "scope": decision.scope,
                "join_risk": join_risk_from_decision(decision),
                "harsh": is_harsh_tighten_hit(decision),
                "listen_one_by_one": is_listen_one_by_one_hit(decision),
                "label": sound_info.label if sound_info else None,
                "suggested_action": sound_info.action if sound_info else None,
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


@dataclass(frozen=True)
class _Recording:
    """The recording a combined row's words come from, and the clips that play it.

    On a lane holding one recording, ``placements`` is ``None`` and words map through
    every clip of the track's media. On a lane holding several takes, each take's words
    map only through that take's own clips (the clip ``source_id`` values that name
    it): mapped through the whole lane, a take's source second also lands wherever
    another take plays the same second, and the transcript lights up rows far from the
    playhead.
    """

    track_id: str
    transcript: Transcript | None
    placements: frozenset[str | None] | None = None

    @property
    def source_id(self) -> str | None:
        return self.transcript.source_id if self.transcript else None

    @property
    def words_key(self) -> tuple[str, str | None]:
        """Identity of the transcript word list this recording reads."""
        return (self.track_id, self.source_id)

    @property
    def key(self) -> tuple[str, str | None, bool]:
        """Identity for caches: the transcript and whether words map per take."""
        return (self.track_id, self.source_id, self.placements is not None)

    def map_span(
        self, timeline: SessionTimeline, start: SourceSec, end: SourceSec
    ) -> list[tuple[TimelineSec, TimelineSec]]:
        if self.placements is not None:
            return timeline.map_placements_source_span(self.track_id, self.placements, start, end)
        return timeline.map_source_span(self.track_id, start, end)

    def map_words(
        self, timeline: SessionTimeline, words: Sequence[tuple[float, float]]
    ) -> list[list[tuple[TimelineSec, TimelineSec]]]:
        if self.placements is not None:
            return timeline.map_placements_word_spans(self.track_id, self.placements, words)
        return timeline.map_word_spans(self.track_id, words)


class _LaneRecordings:
    def __init__(self, project: EpisodeProject) -> None:
        self._project = project
        self._lanes: dict[str, list[_Recording]] = {}
        self._origin_of = origin_resolver(project)

    def _clip_plays_lane(self, clip: Clip, track_id: str) -> bool:
        if self._origin_of(clip) == track_id:
            return True
        return clip.source_id is not None and any(
            tr.track_id == track_id and tr.source_id == clip.source_id
            for tr in self._project.transcripts
        )

    def lane(self, track_id: str) -> list[_Recording]:
        cached = self._lanes.get(track_id)
        if cached is None:
            # One recording can sit under several clip source_id spellings, and a clip
            # moved to another lane still plays this lane's recording, so group the
            # clips that play it by the transcript they resolve to.
            placements: dict[int, tuple[Transcript, set[str | None]]] = {}
            for clip in self._project.clips:
                if not self._clip_plays_lane(clip, track_id):
                    continue
                transcript = self._project.transcript_for_source(track_id, clip.source_id)
                if transcript is not None:
                    placements.setdefault(id(transcript), (transcript, set()))[1].add(
                        clip.source_id
                    )
            if len(placements) > 1:
                cached = [
                    _Recording(track_id, transcript, frozenset(source_ids))
                    for transcript, source_ids in placements.values()
                ]
            else:
                cached = [_Recording(track_id, self._project.transcript_for_track(track_id))]
            self._lanes[track_id] = cached
        return cached

    def primary(self, track_id: str) -> _Recording:
        return self.lane(track_id)[0]

    def for_row(self, row: Mapping[str, Any]) -> _Recording:
        track_id = str(row.get("track_id", ""))
        source_id = row.get("source_id")
        transcript = self._project.transcript_for_source(track_id, source_id)
        lane = self.lane(track_id)
        if len(lane) == 1 and lane[0].transcript is transcript:
            return lane[0]
        if (
            transcript is not None
            and transcript.source_id is None
            and not any(self._clip_plays_lane(clip, track_id) for clip in self._project.clips)
        ):
            return _Recording(track_id, transcript)
        placements = frozenset(
            clip.source_id
            for clip in self._project.clips
            if transcript is not None
            and self._clip_plays_lane(clip, track_id)
            and self._project.transcript_for_source(track_id, clip.source_id) is transcript
        )
        return _Recording(track_id, transcript, placements)

    def for_source(self, track_id: str, source_id: str | None) -> _Recording:
        return self.for_row({"track_id": track_id, "source_id": source_id})


def _mapped_word_index(
    project: EpisodeProject,
    timeline: SessionTimeline,
    track_id: str,
    recording: _Recording | None = None,
) -> _MappedWordIndex:
    recording = recording or _Recording(track_id, project.transcript_for_track(track_id))
    tr = recording.transcript
    words = tr.words if tr is not None else []
    mapped = recording.map_words(timeline, [(w.start, w.end) for w in words])
    views = [
        _word_view(
            timeline,
            track_id,
            i,
            w,
            spans,
            source_id=tr.source_id if tr else None,
        )
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


def _flagged_word_indices_for_utterance(
    words: Sequence[Any],
    intervals: HalfOpenIntervalIndex,
    source_start: float,
    source_end: float,
    attr: str,
    *,
    extra_indices: Sequence[int] = (),
) -> list[int]:
    selected = {
        index
        for index in _covered_word_ordinals(words, intervals, source_start, source_end)
        if bool(getattr(words[index], attr, False))
    }
    selected.update(
        index
        for index in extra_indices
        if index < len(words) and bool(getattr(words[index], attr, False))
    )
    return sorted(selected)


def _ignored_word_indices_for_utterance(
    words: Sequence[Any],
    intervals: HalfOpenIntervalIndex,
    source_start: float,
    source_end: float,
    *,
    extra_indices: Sequence[int] = (),
) -> list[int]:
    """Sorted per-track `word_index` values of ignored words overlapping the utterance (#633)."""
    return _flagged_word_indices_for_utterance(
        words, intervals, source_start, source_end, "ignored", extra_indices=extra_indices
    )


def _locked_word_indices_for_utterance(
    words: Sequence[Any],
    intervals: HalfOpenIntervalIndex,
    source_start: float,
    source_end: float,
    *,
    extra_indices: Sequence[int] = (),
) -> list[int]:
    return _flagged_word_indices_for_utterance(
        words,
        intervals,
        source_start,
        source_end,
        "audibility_locked",
        extra_indices=extra_indices,
    )


def _source_gap(word: Any, span: tuple[float, float]) -> float:
    """Source-time gap between ``word`` and an utterance window it lies outside."""
    return max(span[0] - float(word.end), float(word.start) - span[1])


def _edge_suppressed_word_indices(
    utterances: Sequence[dict[str, Any]],
    words_by_track: Mapping[Any, Sequence[Any]],
    intervals_by_track: Mapping[Any, HalfOpenIntervalIndex] | None = None,
    *,
    row_keys: Sequence[Any] | None = None,
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

    ``row_keys`` names each row's word list in ``words_by_track`` when rows of
    one track read different transcripts (takes); by default it is the row's track.

    Returns a mapping of utterance position (index into ``utterances``) to
    the ascending per-track word indices it owns.
    """
    positions_by_track: dict[Any, list[int]] = {}
    for position, utterance in enumerate(utterances):
        key = row_keys[position] if row_keys is not None else str(utterance.get("track_id", ""))
        positions_by_track.setdefault(key, []).append(position)

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
    sources_with_rows: set[tuple[str, str | None]],
    word_indexes: dict[tuple[str, str | None, bool], _MappedWordIndex],
    recordings: _LaneRecordings,
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
    GUI view. Rows come back in track order (each track's runs ascending);
    the caller sorts them into the transcript by timeline position.
    """
    rows: list[dict[str, Any]] = []
    for transcript in project.transcripts:
        track_id = transcript.track_id
        source_id = transcript.source_id
        if (track_id, source_id) in sources_with_rows:
            continue
        recording = recordings.for_source(track_id, source_id)
        words = transcript.words if transcript is not None else []
        if not words or not all(bool(w.suppressed) for w in words):
            continue
        speaker = utterance_speaker(project, track_id)
        for run in utterance_runs(words):
            run_words = words[run.start : run.stop]
            row = _mapped_row(
                timeline,
                recording,
                {
                    "track_id": track_id,
                    "source_id": source_id,
                    "speaker": speaker,
                    "start": float(run_words[0].start),
                    "end": float(run_words[-1].end),
                    "text": utterance_text(run_words),
                },
            )
            row["suppressed_only"] = True
            if include_words:
                if recording.key not in word_indexes:
                    word_indexes[recording.key] = _mapped_word_index(
                        project, timeline, track_id, recording
                    )
                views = word_indexes[recording.key].views
                row["words"] = [views[i] for i in run]
            ignored = [i for i in run if bool(getattr(words[i], "ignored", False))]
            if ignored:
                row["ignored_word_indices"] = ignored
            locked = [i for i in run if bool(getattr(words[i], "audibility_locked", False))]
            if locked:
                row["locked_word_indices"] = locked
            rows.append(row)
    return rows


def _word_view(
    timeline: SessionTimeline,
    track_id: str,
    word_index: int,
    word: Any,
    spans: list[tuple[Any, Any]] | None = None,
    *,
    source_id: str | None,
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
    view: dict[str, Any] = {
        "text": word.text,
        "start": float(word.start),
        "end": float(word.end),
        "timeline_start": tl_start,
        "timeline_end": tl_end,
        "mappable": mappable,
        "word_index": word_index,
        "timing_target": {"track_id": track_id, "source_id": source_id, "word_index": word_index},
        "confidence": word.confidence,
        "suppressed": bool(word.suppressed),
        "ignored": bool(word.ignored),
        "suspect_hallucination": bool(word.suspect_hallucination),
        "audibility_locked": bool(word.audibility_locked),
    }
    return view


def guest_transcript(
    transcript: dict[str, Any] | None, *, words: bool = False
) -> dict[str, Any] | None:
    """A combined-transcript dict for guests.

    Drops view-only ``suppressed_only`` rows (#758): their text is suppressed words,
    which guests never see. ``words=False`` drops per-word timings; ``words=True``
    keeps them minus suppressed words, for guests who select transcript ranges.
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
        timed = row.pop("words", None)
        if words and isinstance(timed, list):
            row["words"] = [w for w in timed if not (isinstance(w, dict) and w.get("suppressed"))]
        slim.append(row)
    return {**transcript, "utterances": slim}


def _mapped_row(
    timeline: SessionTimeline, recording: _Recording, utterance: Mapping[str, Any]
) -> dict[str, Any]:
    """Utterance row with timeline clocks, ``words`` dropped (padded like a zero-length word, #752)."""
    track_id = str(utterance.get("track_id", ""))
    source_start = float(utterance.get("start", 0.0))
    source_end = float(utterance.get("end", 0.0))
    timeline_spans = timeline_span_dicts(
        recording.map_span(timeline, *word_source_span(source_start, source_end))
    )
    mappable = bool(timeline_spans)
    timeline_start = timeline_spans[0]["start"] if timeline_spans else None
    timeline_end = timeline_spans[-1]["end"] if timeline_spans else None
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
    recordings = _LaneRecordings(project)
    rows: list[dict[str, Any]] = []
    row_recordings: list[_Recording] = []
    raw_words: dict[tuple[str, str | None], list[Any]] = {}
    raw_intervals: dict[tuple[str, str | None], HalfOpenIntervalIndex] = {}
    for utterance in utterances:
        if not isinstance(utterance, dict):
            continue
        recording = recordings.for_row(utterance)
        row = _mapped_row(timeline, recording, utterance)
        if recording.words_key not in raw_words:
            tr = recording.transcript
            raw_words[recording.words_key] = list(tr.words) if tr is not None else []
            raw_intervals[recording.words_key] = _raw_word_intervals(raw_words[recording.words_key])
        rows.append(row)
        row_recordings.append(recording)

    edge_suppressed = _edge_suppressed_word_indices(
        rows, raw_words, raw_intervals, row_keys=[r.words_key for r in row_recordings]
    )

    mapped: list[dict[str, Any]] = []
    word_indexes: dict[tuple[str, str | None, bool], _MappedWordIndex] = {}
    for position, (row, recording) in enumerate(zip(rows, row_recordings, strict=True)):
        track_id = row["track_id"]
        key = recording.key
        source_start = row["start"]
        source_end = row["end"]
        extra_indices = edge_suppressed.get(position, [])
        if extra_indices:
            row["edge_suppressed_word_indices"] = sorted(extra_indices)
        if include_words:
            if key not in word_indexes:
                word_indexes[key] = _mapped_word_index(project, timeline, track_id, recording)
            row["words"] = _words_for_utterance(
                project,
                timeline,
                track_id,
                source_start,
                source_end,
                word_indexes[key],
                extra_indices=extra_indices,
            )
        ignored_word_indices = _ignored_word_indices_for_utterance(
            raw_words[recording.words_key],
            raw_intervals[recording.words_key],
            source_start,
            source_end,
            extra_indices=extra_indices,
        )
        if ignored_word_indices:
            row["ignored_word_indices"] = ignored_word_indices
        locked_word_indices = _locked_word_indices_for_utterance(
            raw_words[recording.words_key],
            raw_intervals[recording.words_key],
            source_start,
            source_end,
            extra_indices=extra_indices,
        )
        if locked_word_indices:
            row["locked_word_indices"] = locked_word_indices
        mapped.append(row)

    synthetic = _suppressed_only_rows(
        project,
        timeline,
        {(row["track_id"], row.get("source_id")) for row in rows},
        word_indexes,
        recordings,
        include_words=include_words,
    )
    if synthetic:
        # Stable sort by source start: synthetic rows are ordered only within each
        # track, so a merge would not do. Input rows come first, so they win ties.
        mapped = sorted([*mapped, *synthetic], key=lambda row: row["start"])
    by_timeline = any(rec.placements for rec in row_recordings)
    return {**transcript, "utterances": _in_playback_order(mapped) if by_timeline else mapped}


def _in_playback_order(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rows in the order the timeline plays them.

    The combined transcript is ordered by source start. That is wrong once a lane
    holds several takes: a later take's source clock restarts at 0, so its rows land
    among the first take's. Following the playhead walks this list, so such a view
    sorts every row by its timeline start. (A view without a multi-take lane keeps
    source order, which a clip move or paste does not disturb.) A row that does not
    play (cut away) keeps its place after the row before it. The sort is stable, so
    rows starting together keep their source order.
    """
    keys: list[float] = []
    last = float("-inf")
    for row in rows:
        if row.get("timeline_start") is not None:
            last = float(row["timeline_start"])
        keys.append(last)
    order = sorted(range(len(rows)), key=keys.__getitem__)
    return [rows[i] for i in order]


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
    # One selected-recording word map per (track, source); joins reuse it (#1610).
    word_span_cache: dict[tuple[str, str | None], list[list[tuple[TimelineSec, TimelineSec]]]] = {}
    track_ids = sorted({c.track_id for c in project.clips})
    for track_id in track_ids:
        clips = clips_for_track(project, track_id)
        for i, left in enumerate(clips):
            if i + 1 >= len(clips):
                continue
            right = clips[i + 1]
            left_transcript = project.transcript_for_source(track_id, left.source_id)
            right_transcript = project.transcript_for_source(track_id, right.source_id)
            same_recording = left.source_id == right.source_id or (
                left_transcript is not None and left_transcript is right_transcript
            )
            shared_transcript = left_transcript is not None and left_transcript is right_transcript
            cutaway_start = float(left.source_end)
            cutaway_end = float(right.source_start)
            if not same_recording or cutaway_end < cutaway_start:
                cutaway_end = cutaway_start
            cutaway_word_ids: list[dict[str, Any]] = []
            if shared_transcript and cutaway_end > cutaway_start + 1e-9:
                assert left_transcript is not None
                active_words = left_transcript.words
                archived_words = [entry.word for entry in left_transcript.archived_words]
                preview_words = [
                    (index, ordinal, word)
                    for index, (ordinal, word) in enumerate(
                        left_transcript.active_words_with_ordinals()
                    )
                ]
                preview_words.extend(
                    (len(active_words) + index, entry.ordinal, entry.word)
                    for index, entry in enumerate(left_transcript.archived_words)
                )
                # Only words that reach into this cutaway are mapped: the rest are skipped
                # below, so the per-word timeline mapping no longer scales with the transcript.
                span_key = (track_id, left.source_id)
                if span_key not in word_span_cache:
                    word_span_cache[span_key] = timeline.map_selected_word_spans(
                        track_id,
                        left.source_id,
                        [(w.start, w.end) for w in [*active_words, *archived_words]],
                    )
                full_word_spans = word_span_cache[span_key]
                word_spans = {
                    word_index: full_word_spans[word_index]
                    for word_index, _ordinal, word in preview_words
                    if float(word_source_span(word.start, word.end)[1]) > cutaway_start
                    and float(word.start) < cutaway_end
                }
                for word_index, _ordinal, word in sorted(
                    preview_words, key=lambda row: (row[2].start, row[1], row[0])
                ):
                    w_end = float(word_source_span(word.start, word.end)[1])
                    if w_end <= cutaway_start or float(word.start) >= cutaway_end:
                        continue
                    if word.end <= word.start and _spans_overlap_clip(word_spans[word_index], left):
                        continue  # the timeline maps it onto the left clip (#621)
                    cutaway_word_ids.append(
                        {
                            "track_id": track_id,
                            "source_id": left.source_id,
                            # Cutaway references are previews, never active word identities.
                            "word_index": -1 - word_index,
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
