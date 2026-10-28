"""Unsure words: the one rule, and which of them sit inside a pending cut.

A transcript word is *unsure* when its ASR confidence is below
``analysis.unsure_word_confidence`` (``config.defaults.unsure_word_confidence``) and it is not
suppressed. A word with no confidence is not unsure, and a word the transcript review
confirmed (``confidence = 1.0``) stops being one. Every surface reads :func:`is_unsure_word`:
the mapped word's ``unsure`` flag, ``list_low_confidence``, the refine brief, a pending cut's
``unsure_words`` and the ``skip_unsure`` bulk-approve guard.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Any

from podcast_mcp.engines.session_timeline import word_source_span
from podcast_mcp.models import EditDecision, EditDecisionType, EpisodeProject, TranscriptWord
from podcast_mcp.util.intervals import HalfOpenIntervalIndex


def is_unsure_word(word: TranscriptWord, threshold: float) -> bool:
    """Whether ``word`` is below the unsure line (suppressed words never count)."""
    return (
        not word.suppressed and word.confidence is not None and float(word.confidence) < threshold
    )


def unsure_predicate(threshold: float) -> Callable[[TranscriptWord], bool]:
    """``is_unsure_word`` bound to one threshold, for code that maps many words."""
    return lambda word: is_unsure_word(word, threshold)


def _word_span(word: TranscriptWord) -> tuple[float, float]:
    start, end = word_source_span(word.start, word.end)
    return float(start), float(end)


def unsure_words_by_edit(
    project: EpisodeProject, edits: Iterable[EditDecision], threshold: float
) -> dict[str, list[dict[str, Any]]]:
    """For each source-clock cut, the unsure words whose span overlaps it, in word order.

    One index per transcript holds only its unsure words, so the work is linear in the words
    plus a logarithmic lookup per cut. Cuts on the timeline clock (blades, exact ranges)
    name no transcript words and get ``[]``. Each entry is
    ``{track_id, source_id, word_index, text, confidence}``.
    """
    indexes: dict[
        tuple[str, str | None],
        tuple[Any, list[int], HalfOpenIntervalIndex] | None,
    ] = {}

    def index_for(track_id: str, source_id: str | None):
        key = (track_id, source_id)
        if key not in indexes:
            transcript = project.transcript_for_source(track_id, source_id)
            if transcript is None:
                indexes[key] = None
            else:
                unsure = [i for i, w in enumerate(transcript.words) if is_unsure_word(w, threshold)]
                spans = HalfOpenIntervalIndex.build(_word_span(transcript.words[i]) for i in unsure)
                indexes[key] = (transcript, unsure, spans)
        return indexes[key]

    found: dict[str, list[dict[str, Any]]] = {}
    for edit in edits:
        found[edit.id] = []
        if (
            edit.exact_range is not None
            or edit.timebase != "source"
            or edit.type == EditDecisionType.SPLIT
        ):
            continue
        entry = index_for(edit.track_id, edit.source_id)
        if entry is None:
            continue
        transcript, unsure, spans = entry
        if not unsure:
            continue
        start, end = float(edit.start), float(edit.end)
        for ordinal in sorted(spans.overlapping_ordinals(start, end)):
            word_index = unsure[ordinal]
            word = transcript.words[word_index]
            found[edit.id].append(
                {
                    "track_id": transcript.track_id,
                    "source_id": transcript.source_id,
                    "word_index": word_index,
                    "text": word.text,
                    "confidence": float(word.confidence),
                }
            )
    return found
