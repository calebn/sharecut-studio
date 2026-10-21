"""Repetition and restart candidate collection."""

from __future__ import annotations

import re
from itertools import pairwise
from typing import TYPE_CHECKING, Any

from podcast_mcp.config.defaults import bounded_float
from podcast_mcp.models import (
    TranscriptWord,
)
from podcast_mcp.util.text import lexicon_form, normalize_text

if TYPE_CHECKING:
    pass
from podcast_mcp.edits.tighten.candidate import (
    _CutCandidate,
)
from podcast_mcp.edits.tighten.lexicon import (
    _backchannel_set,
    _lexicon,
    _lexicon_phrase_hits,
    _prev_nonsuppressed,
    _span_confidence,
)

_RESTART_MARKERS = re.compile(r"(?:[-\u2013\u2014]|\.\.\.|\u2026)$")


_REPEAT_GAP_SEC = 0.45


_MAX_RESTART_WORDS = 4


def _repeat_token(word: TranscriptWord) -> str:
    """The word in :func:`lexicon_form`; restart markers are read from the raw text."""
    return lexicon_form(word.text)


def _words_are_contiguous(
    words: list[TranscriptWord], left_i: int, right_i: int, max_gap: float
) -> bool:
    left = words[left_i]
    right = words[right_i]
    return (
        right_i == left_i + 1
        and left.end <= right.start
        and right.start - left.end <= max_gap
        and not left.suppressed
        and not right.suppressed
        and left.end > left.start
        and right.end > right.start
    )


def _bounded_repeat_start(words: list[TranscriptWord], reparandum_start_i: int) -> float:
    """Floor for a repeat/restart cut: the end of the preceding surviving word.

    Whisper times leave adjacent words touching, so this floor equals the
    reparandum's own start there. Aligned times leave a real gap between
    words; clamping the floor to the reparandum's own start (the old
    behavior) stranded that gap as unremoved air on the left. The preceding
    *surviving* word is never part of the cut, so its end is always a safe
    floor -- a suppressed word can sit between two kept words with a span
    that overlaps the kept one before it (already-cut material), so skip
    suppressed entries via ``_prev_nonsuppressed`` rather than reading
    ``words[i - 1]`` directly (#792 review). Falls back to the reparandum's
    own start when there is no preceding surviving word.
    """
    prev_i = _prev_nonsuppressed(words, reparandum_start_i)
    if prev_i is not None:
        return words[prev_i].end
    return words[reparandum_start_i].start


_MIN_REPARANDUM_OVERLAP_FRACTION = 0.5


def _cut_covers_reparandum(candidate: _CutCandidate, start: float, end: float) -> bool:
    """True when the final cut still removes most of the word(s) it targeted.

    Widening a repeat/restart cut's bounds to the flanking silence (#783)
    gives waveform snapping and breath extension room to slide the cut well
    away from the reparandum, inside those bounds. A cut that ends up barely
    touching the reparandum removes neither copy and leaves both audible --
    reject it rather than propose a no-op edit (PR #792 review). A voiced-edge
    nudge (#815) is held to the same bar for every word-targeted cut.
    """
    span = candidate.end - candidate.start
    if span <= 0:
        return True
    overlap = min(end, candidate.end) - max(start, candidate.start)
    return overlap >= _MIN_REPARANDUM_OVERLAP_FRACTION * span


def _collect_repetition_candidates(
    words: list[TranscriptWord],
    track_id: str,
    tighten: dict[str, Any],
) -> list[_CutCandidate]:
    """Find local reparanda (repeated words/prefixes) without guessing semantics.

    Only same-track, timestamp-adjacent words are considered.  Every repetition
    remains review-required: ``very very`` and emphatic restarts are valid speech,
    while a human can safely approve the small preceding span when it is a
    disfluency.  A trailing cut-off marker (``stor- store``) is the sole partial
    word exception and is likewise never auto-applied.
    """
    max_gap = bounded_float(
        tighten.get("repeat_max_gap_sec", _REPEAT_GAP_SEC), _REPEAT_GAP_SEC, 0.0, 2.0
    )
    lexicon = _lexicon(tighten.get("filler_words", [])) | _backchannel_set(tighten)
    usable = [i for i, word in enumerate(words) if not word.suppressed and word.end > word.start]
    # A phrase such as ``you know`` or ``uh huh`` is one lexicon entry even though
    # ASR represents it as two words.  Do not reinterpret either occurrence as a
    # lexical restart (``you know you know``) after filler selection has made
    # that classification.
    lexicon_word_indexes = {
        word_index
        for start_i, end_i, _token in _lexicon_phrase_hits(words, lexicon)
        for word_index in range(start_i, end_i + 1)
    }
    candidates: list[_CutCandidate] = []
    seen: set[tuple[int, int]] = set()
    consumed_positions: set[int] = set()
    for pos, first_i in enumerate(usable):
        first = words[first_i]
        first_token = _repeat_token(first)
        if pos in consumed_positions or not first_token or first_i in lexicon_word_indexes:
            continue
        # Explicitly marked partial words are clear reparanda; do not infer a
        # cut-off from ASR token similarity alone.
        if _RESTART_MARKERS.search(normalize_text(first.text)) and pos + 1 < len(usable):
            second_i = usable[pos + 1]
            second = words[second_i]
            second_token = _repeat_token(second)
            partial = first_token
            if (
                len(partial) >= 2
                and second_token.startswith(partial)
                and second_token != partial
                and _words_are_contiguous(words, first_i, second_i, max_gap)
            ):
                seen.add((first_i, first_i))
                consumed_positions.update((pos, pos + 1))
                candidates.append(
                    _CutCandidate(
                        track_id=track_id,
                        start=first.start,
                        end=first.end,
                        reason=f"restart:partial:{partial}",
                        cut_kind="restart",
                        filler_confidence=first.confidence,
                        min_start=_bounded_repeat_start(words, first_i),
                        max_end=second.start,
                    )
                )
                continue
        # ASR may split a restart as ``I w- I went``.  Accept a marked partial
        # token after a short repeated prefix, but only when the repair resumes
        # with that same prefix and the partial token's text is a prefix of the
        # following repair word.
        split_repair_found = False
        for prefix_len in range(1, 3):
            partial_pos = pos + prefix_len
            repair_pos = partial_pos + prefix_len + 1
            if repair_pos >= len(usable) or partial_pos >= len(usable):
                continue
            prefix_left = usable[pos:partial_pos]
            prefix_right = usable[partial_pos + 1 : repair_pos]
            if not all(
                _repeat_token(words[a]) == _repeat_token(words[b])
                for a, b in zip(prefix_left, prefix_right, strict=True)
            ):
                continue
            partial_i = usable[partial_pos]
            repair_i = usable[repair_pos]
            partial_word = words[partial_i]
            repair_word = words[repair_i]
            partial_raw = normalize_text(partial_word.text)
            partial = _repeat_token(partial_word)
            if (
                _RESTART_MARKERS.search(partial_raw)
                and len(partial) >= 1
                and _repeat_token(repair_word).startswith(partial)
                and all(
                    _words_are_contiguous(words, a, b, max_gap)
                    for a, b in pairwise([*prefix_left, partial_i, *prefix_right, repair_i])
                )
            ):
                start_i = prefix_left[0]
                seen.add((start_i, partial_i))
                consumed_positions.update(range(pos, repair_pos + 1))
                candidates.append(
                    _CutCandidate(
                        track_id=track_id,
                        # Remove the false start as one reparandum.  For
                        # ``I w- I went``, retaining only ``I went`` avoids
                        # leaving the leading repeated pronoun behind.
                        start=words[start_i].start,
                        end=partial_word.end,
                        reason=f"restart:partial:{partial}",
                        cut_kind="restart",
                        filler_confidence=partial_word.confidence,
                        min_start=_bounded_repeat_start(words, start_i),
                        max_end=repair_word.start,
                    )
                )
                split_repair_found = True
                break
        if split_repair_found:
            continue
        if pos + 1 >= len(usable):
            continue
        # Prefer the longest repeated prefix.  A phrase restart is one review
        # decision, not a stack of overlapping one-token decisions.
        phrase_found = False
        for length in range(_MAX_RESTART_WORDS, 1, -1):
            if pos + 2 * length > len(usable):
                continue
            left = usable[pos : pos + length]
            right = usable[pos + length : pos + 2 * length]
            if any(index in lexicon_word_indexes for index in (*left, *right)):
                continue
            if any(
                not _words_are_contiguous(words, sequence[a], sequence[a + 1], max_gap)
                for sequence in (left, right)
                for a in range(len(sequence) - 1)
            ):
                continue
            if not all(
                _repeat_token(words[a]) == _repeat_token(words[b])
                and _repeat_token(words[a]) not in lexicon
                for a, b in zip(left, right, strict=True)
            ):
                continue
            if not _words_are_contiguous(words, left[-1], right[0], max_gap):
                continue
            start_i, end_i = left[0], left[-1]
            if (start_i, end_i) in seen:
                continue
            seen.add((start_i, end_i))
            # Consume the repair as well as the removed reparandum.  Without
            # this, periodic speech such as ``a b a b a b`` produces adjacent
            # phrase candidates that later coalesce into one large cut.
            consumed_positions.update(range(pos, pos + 2 * length))
            candidates.append(
                _CutCandidate(
                    track_id=track_id,
                    start=words[start_i].start,
                    end=words[end_i].end,
                    reason=(
                        f"restart:phrase:{' '.join(_repeat_token(words[idx]) for idx in left)}"
                    ),
                    cut_kind="restart",
                    filler_confidence=_span_confidence(words, start_i, end_i),
                    min_start=_bounded_repeat_start(words, start_i),
                    max_end=words[right[0]].start,
                )
            )
            phrase_found = True
            break
        if phrase_found:
            continue
        second_i = usable[pos + 1]
        second = words[second_i]
        if (
            first_token == _repeat_token(second)
            and first_token not in lexicon
            and _words_are_contiguous(words, first_i, second_i, max_gap)
        ):
            key = (first_i, first_i)
            if key not in seen:
                seen.add(key)
                consumed_positions.update((pos, pos + 1))
                candidates.append(
                    _CutCandidate(
                        track_id=track_id,
                        start=first.start,
                        end=first.end,
                        reason=f"repetition:word:{first_token}",
                        cut_kind="repeat",
                        filler_confidence=first.confidence,
                        min_start=_bounded_repeat_start(words, first_i),
                        max_end=second.start,
                    )
                )
    return candidates
