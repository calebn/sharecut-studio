from __future__ import annotations

import logging
import math
import re
from bisect import bisect_left
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import Any

import numpy as np

from podcast_mcp.config import bounded_float
from podcast_mcp.edits.acoustic_gap import AcousticGapConfig, find_voiced_gap_runs
from podcast_mcp.edits.audio_cache import TrackAudioCache, build_track_audio_caches
from podcast_mcp.edits.breath_detect import detect_adjacent_breath, extend_cut_for_breaths
from podcast_mcp.edits.cut_quality import (
    assess_cut_risk,
    optimize_and_assess,
    recommend_cut_fade_ms,
)
from podcast_mcp.edits.filler_pacing import apply_filler_pacing
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.edits.tighten_intensity import with_tighten_intensity
from podcast_mcp.edits.tighten_reasons import ACOUSTIC_FILLER_REASON
from podcast_mcp.edits.transcript_cuts import append_remove_decision
from podcast_mcp.edits.voiced_runs import (
    FRAME_SEC,
    audible_runs,
    run_straddling,
    voiced_runs,
    voiced_sec_inside,
)
from podcast_mcp.models import (
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.util.dsp import db_to_amplitude
from podcast_mcp.util.intervals import HalfOpenIntervalIndex
from podcast_mcp.util.text import normalize_text
from podcast_mcp.util.tracks import dialogue_track_ids

log = logging.getLogger(__name__)

# Discourse markers stay in `tighten.filler_words` but are demoted: they become
# cut candidates only with an adjacent true disfluency/repeat, a pause bound, or
# low ASR confidence. Defaults match `.agents/defaults/pipeline.yaml`.
# Missing `discourse_markers` uses these defaults; explicit `[]` disables demotion.
DEFAULT_DISCOURSE_MARKERS = ("like", "you know", "sort of", "kind of")
DEFAULT_DISCOURSE_PAUSE_SEC = 0.35
DEFAULT_DISCOURSE_CONFIDENCE_MAX = 0.6
_DISCOURSE_PAUSE_SEC_MAX = 5.0
_LexiconHit = tuple[int, int, str]


@dataclass(frozen=True)
class _SpeakerCutContext:
    config: Any
    profiles: dict[str, Any]


def _speaker_cut_context(project: EpisodeProject) -> _SpeakerCutContext | None:
    """Take one profile/config snapshot before candidate analysis starts."""
    try:
        from podcast_mcp.engines.speaker_id import load_all_profiles
        from podcast_mcp.transcript_context import load_transcript_context

        profiles = load_all_profiles(project)
        if not profiles:
            return _SpeakerCutContext(None, {})
        config = load_transcript_context(project.workspace_path()).speaker_id
        return _SpeakerCutContext(config, profiles)
    except Exception as exc:
        log.debug("speaker bleed cut guard skipped: %s", exc, exc_info=True)
        return _SpeakerCutContext(None, {})


def _word_not_owner(word: TranscriptWord, track_id: str) -> bool:
    """True when ``word`` is bleed or speaker-matched to another track."""
    if word.audibility_status == "bleed":
        return True
    return bool(word.speaker_match_track and word.speaker_match_track != track_id)


def _cut_span_is_bleed_not_owner(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    speaker_context: _SpeakerCutContext | None = None,
    word_index: CutWordIndex | None = None,
) -> bool:
    if word_index is not None:
        if word_index.has_bleed_overlap(start, end):
            return True
    else:
        tr = project.transcript_for_track(track_id)
        if tr:
            for w in tr.words:
                if w.end <= start or w.start >= end:
                    continue
                if _word_not_owner(w, track_id):
                    return True
    try:
        from podcast_mcp.engines.speaker_id import assess_speaker_cut_role

        context = speaker_context if speaker_context is not None else _speaker_cut_context(project)
        if context is None or not context.profiles:
            return False
        role = assess_speaker_cut_role(
            project, track_id, start, end, context.config, profiles=context.profiles
        )
        return bool(role and role.get("role") == "bleed")
    except Exception as exc:
        log.debug("speaker bleed cut guard skipped: %s", exc, exc_info=True)
        return False


def _lexicon_phrase_hits(words: list[TranscriptWord], lexicon: set[str]) -> list[_LexiconHit]:
    """Greedy left-to-right longest contiguous lexicon matches.

    Multi-word entries (``you know``) match split ASR tokens the same way
    ``timeline_ops._exact_phrase_match`` compares ``norms[i : i + len(q_words)]``.
    """
    if not lexicon:
        return []
    phrase_lens = sorted({len(p.split()) for p in lexicon}, reverse=True)
    kept = [(i, w) for i, w in enumerate(words) if not w.suppressed and w.end > w.start]
    if not kept:
        return []
    norms = [normalize_text(w.text) for _, w in kept]
    hits: list[_LexiconHit] = []
    i = 0
    while i < len(kept):
        matched = False
        for plen in phrase_lens:
            if i + plen > len(kept):
                continue
            token = " ".join(norms[i : i + plen])
            if token not in lexicon:
                continue
            hits.append((kept[i][0], kept[i + plen - 1][0], token))
            i += plen
            matched = True
            break
        if not matched:
            i += 1
    return hits


def _cluster_lexicon_hits(
    words: list[TranscriptWord],
    hits: list[_LexiconHit],
    *,
    cluster_gap_sec: float,
) -> list[list[_LexiconHit]]:
    """Group nearby lexicon hits (including size-1 groups) by ``cluster_gap_sec``."""
    clusters: list[list[_LexiconHit]] = []
    current: list[_LexiconHit] = []
    for hit in hits:
        if not current:
            current = [hit]
            continue
        prev_end = words[current[-1][1]].end
        gap = words[hit[0]].start - prev_end
        if gap <= cluster_gap_sec:
            current.append(hit)
        else:
            clusters.append(current)
            current = [hit]
    if current:
        clusters.append(current)
    return clusters


def _discourse_marker_set(tighten: dict[str, Any]) -> set[str]:
    if "discourse_markers" not in tighten:
        raw: list[Any] = list(DEFAULT_DISCOURSE_MARKERS)
    else:
        raw = list(tighten.get("discourse_markers") or [])
    return {normalize_text(str(w)) for w in raw if str(w).strip()}


def _prev_nonsuppressed(words: list[TranscriptWord], index: int) -> int | None:
    for j in range(index - 1, -1, -1):
        if not words[j].suppressed and words[j].end > words[j].start:
            return j
    return None


def _next_nonsuppressed(words: list[TranscriptWord], index: int) -> int | None:
    for j in range(index + 1, len(words)):
        if not words[j].suppressed and words[j].end > words[j].start:
            return j
    return None


def _hits_are_adjacent(words: list[TranscriptWord], left: _LexiconHit, right: _LexiconHit) -> bool:
    """True when no nonsuppressed word sits between ``left`` and ``right`` spans."""
    return _next_nonsuppressed(words, left[1]) == right[0]


def _adjacent_true_disfluency(
    words: list[TranscriptWord],
    group: list[_LexiconHit],
    index: int,
    discourse: set[str],
) -> bool:
    if index > 0:
        prev = group[index - 1]
        if prev[2] not in discourse and _hits_are_adjacent(words, prev, group[index]):
            return True
    if index + 1 < len(group):
        nxt = group[index + 1]
        if nxt[2] not in discourse and _hits_are_adjacent(words, group[index], nxt):
            return True
    return False


def _adjacent_repeat(words: list[TranscriptWord], group: list[_LexiconHit], index: int) -> bool:
    token = group[index][2]
    if (
        index > 0
        and group[index - 1][2] == token
        and _hits_are_adjacent(words, group[index - 1], group[index])
    ):
        return True
    return (
        index + 1 < len(group)
        and group[index + 1][2] == token
        and _hits_are_adjacent(words, group[index], group[index + 1])
    )


def _pause_bounded_span(
    words: list[TranscriptWord],
    start_i: int,
    end_i: int,
    pause_sec: float,
) -> bool:
    first = words[start_i]
    last = words[end_i]
    prev = _prev_nonsuppressed(words, start_i)
    if prev is None:
        if first.start >= pause_sec:
            return True
    elif first.start - words[prev].end >= pause_sec:
        return True
    nxt = _next_nonsuppressed(words, end_i)
    return nxt is not None and words[nxt].start - last.end >= pause_sec


def _span_confidence(words: list[TranscriptWord], start_i: int, end_i: int) -> float | None:
    confs: list[float] = []
    for j in range(start_i, end_i + 1):
        word = words[j]
        if word.suppressed or word.confidence is None:
            continue
        confs.append(word.confidence)
    return min(confs) if confs else None


def _low_discourse_confidence_span(
    words: list[TranscriptWord],
    start_i: int,
    end_i: int,
    confidence_max: float,
) -> bool:
    conf = _span_confidence(words, start_i, end_i)
    return conf is not None and conf < confidence_max


def _count_skip(skip_counts: dict[str, int] | None, reason: str) -> None:
    if skip_counts is None:
        return
    skip_counts[reason] = skip_counts.get(reason, 0) + 1


def normalize_edit_mode(raw: Any) -> str:
    mode = str(raw or "ripple").strip().lower()
    return mode if mode in ("ripple", "mute") else "ripple"


def _edit_mode(tighten: dict[str, Any]) -> str:
    return normalize_edit_mode(tighten.get("edit_mode"))


@dataclass(frozen=True)
class _CutCandidate:
    """A filler/pause span worth analyzing, before waveform/risk analysis runs."""

    track_id: str
    start: float
    end: float
    reason: str
    cut_kind: str
    filler_confidence: float | None = None
    # Pause cuts: hard ceiling so trailing-energy / breath cannot eat the retain floor.
    max_end: float | None = None
    # Strictly bounded candidates (acoustic gap runs; repetition/restart word
    # spans): hard floor so waveform snapping, breath extension, and pacing
    # never move the cut off the identified span onto a neighboring word; such
    # candidates also skip gap expansion during pacing.
    min_start: float | None = None
    # Proposal-only regardless of risk (never auto-applied).
    review_only: bool = False

    @property
    def strictly_bounded(self) -> bool:
        return self.min_start is not None


def _candidate_order(candidate: _CutCandidate) -> tuple[float, float, str]:
    return (candidate.start, candidate.end, candidate.reason)


def _clamp_to_candidate(
    candidate: _CutCandidate, start: float, end: float
) -> tuple[float, float] | None:
    """Clamp a cut to the candidate's hard bounds; ``None`` when nothing is left."""
    if candidate.min_start is not None:
        start = max(start, candidate.min_start)
    if candidate.max_end is not None:
        end = min(end, candidate.max_end)
    if end <= start:
        return None
    return start, end


_RESTART_MARKERS = re.compile(r"(?:[-\u2013\u2014]|\.\.\.|\u2026)$")
_REPEAT_GAP_SEC = 0.45
_MAX_RESTART_WORDS = 4


def _repeat_token(word: TranscriptWord) -> str:
    """Return a conservative comparison token, retaining punctuation separately."""
    return normalize_text(word.text).strip(".,!?;:()[]{}\"'").rstrip("-\u2013\u2014\u2026")


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
    filler_words = {
        normalize_text(str(value))
        for value in tighten.get("filler_words", [])
        if str(value).strip()
    }
    usable = [i for i, word in enumerate(words) if not word.suppressed and word.end > word.start]
    # A phrase such as ``you know`` is one filler lexicon entry even though ASR
    # represents it as two words.  Do not reinterpret either occurrence as a
    # lexical restart (``you know you know``) after filler selection has made
    # that classification.
    filler_word_indexes = {
        word_index
        for start_i, end_i, _token in _lexicon_phrase_hits(words, filler_words)
        for word_index in range(start_i, end_i + 1)
    }
    candidates: list[_CutCandidate] = []
    seen: set[tuple[int, int]] = set()
    consumed_positions: set[int] = set()
    for pos, first_i in enumerate(usable):
        first = words[first_i]
        first_token = _repeat_token(first)
        if pos in consumed_positions or not first_token or first_i in filler_word_indexes:
            continue
        # Explicitly marked partial words are clear reparanda; do not infer a
        # cut-off from ASR token similarity alone.
        if _RESTART_MARKERS.search(normalize_text(first.text)) and pos + 1 < len(usable):
            second_i = usable[pos + 1]
            second = words[second_i]
            second_token = _repeat_token(second)
            partial = first_token.rstrip("-\u2013\u2014\u2026")
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
            if any(index in filler_word_indexes for index in (*left, *right)):
                continue
            if any(
                not _words_are_contiguous(words, sequence[a], sequence[a + 1], max_gap)
                for sequence in (left, right)
                for a in range(len(sequence) - 1)
            ):
                continue
            if not all(
                _repeat_token(words[a]) == _repeat_token(words[b])
                and _repeat_token(words[a]) not in filler_words
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
            and first_token not in filler_words
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


@dataclass(frozen=True)
class _AnalyzedCut:
    """Result of analyzing one candidate -- everything needed to append a decision.

    Produced by the read-only, parallelizable _analyze_candidate; applying it
    (mutating project.edit_decisions) is a separate, serial step so callers can
    gather many of these concurrently and apply them afterward in a fixed order.
    """

    track_id: str
    start: float
    end: float
    reason: str
    review_required: bool
    crossfade_ms: int
    cut_confidence: float
    boundary_mode: str
    replace_gap_sec: float | None = None
    scope: str = "session"
    decision_type: str = "remove"


def _peer_speaking_in_gap(
    project: EpisodeProject,
    track_id: str,
    gap_start: float,
    gap_end: float,
    peer_indexes: dict[str, _PeerTrackSpeechIndex] | None = None,
) -> bool:
    """True when another dialogue transcript has audible words in the gap.

    A peer muted in the mix still counts: the mute is a listening choice, and
    a cut here ripples the muted track too.
    """
    from podcast_mcp.models import TrackRole

    if peer_indexes is not None:
        index = peer_indexes.get(track_id)
        if index is not None:
            return index.overlaps(gap_start, gap_end)

    for tr in project.transcripts:
        if tr.track_id == track_id:
            continue
        track = project.track_by_id(tr.track_id)
        if track is None or track.role != TrackRole.DIALOGUE:
            continue
        for w in tr.words:
            if w.suppressed or w.end <= gap_start or w.start >= gap_end:
                continue
            return True
    return False


def _clip_containing_source(project: EpisodeProject, track_id: str, src: float):
    """Clip whose source span contains ``src``, if any."""
    from podcast_mcp.edits.clips_ops import clips_for_track

    for clip in clips_for_track(project, track_id):
        if clip.source_start - 1e-6 <= src <= clip.source_end + 1e-6:
            return clip
    return None


def _contiguous_retain_before_word(
    project: EpisodeProject, track_id: str, gap_start: float, gap_end: float
) -> tuple[float, float]:
    """Contiguous source retain immediately before ``gap_end`` (next word).

    Returns ``(retain_start, retain_end)`` inside the clip that holds the next
    word. Holes from prior ripples are not counted - only air that will play
    as one continuous breath into the resume word.
    """
    host = _clip_containing_source(project, track_id, gap_end)
    if host is None:
        return gap_end, gap_end
    retain_start = max(float(host.source_start), float(gap_start))
    retain_end = float(gap_end)
    if retain_end <= retain_start + 1e-9:
        return retain_end, retain_end
    return retain_start, retain_end


def _pause_trim_end_for_timeline_floor(
    project: EpisodeProject,
    track_id: str,
    gap_start: float,
    gap_end: float,
    floor_sec: float,
) -> float | None:
    """Source cut end so contiguous retain before the next word meets ``floor``.

    Prior ripples can punch holes in an ASR gap. Keep ``floor_sec`` of continuous
    source in the clip that contains the next word; cut the excess before that
    retain. When contiguous air is shorter than ``floor``, cut up to the clip
    head and let analyze pad the shortfall with silence.
    """
    retain_start, retain_end = _contiguous_retain_before_word(project, track_id, gap_start, gap_end)
    contiguous = retain_end - retain_start
    if contiguous <= 0.02:
        if gap_end <= gap_start + 0.02:
            return None
        return max(gap_start + 0.02, min(gap_end - 0.02, retain_start))

    if contiguous + 1e-9 >= floor_sec:
        trim = retain_end - floor_sec
        if trim <= gap_start + 0.02:
            return None
        return trim

    trim = retain_start
    if trim <= gap_start + 0.02:
        return None
    return trim


def _timeline_pause_gap_sec(
    project: EpisodeProject, track_id: str, gap_start: float, gap_end: float
) -> float:
    """Audible timeline duration remaining in a source word gap.

    ``TranscriptWord`` timestamps stay in source-media seconds even after a
    ripple delete removes the material between them (see
    ``docs/architecture.md`` Timebase), so two words that are adjacent in the
    surviving transcript can still be far apart on the source clock. Map the
    gap through :class:`SessionTimeline` and sum only the spans that still
    have a clip -- material a ripple already deleted contributes nothing.
    """
    from podcast_mcp.engines.session_timeline import SessionTimeline
    from podcast_mcp.util.timebase import SourceSec

    spans = SessionTimeline(project).map_source_span(
        track_id, SourceSec(gap_start), SourceSec(gap_end)
    )
    return sum(float(end) - float(start) for start, end in spans)


def _retained_pause_floor_sec(
    project: EpisodeProject,
    track_id: str,
    gap_start: float,
    gap_end: float,
    defaults: dict[str, Any],
    peer_indexes: dict[str, _PeerTrackSpeechIndex] | None = None,
) -> tuple[float, bool]:
    """How much pause air to keep; solo thinking pauses keep more than turn gaps.

    Returns (floor_sec, is_solo). Peer speech in the gap → turn/dead-air floor
    (``min_retained_pause_sec``). Quiet peers → same-speaker thinking floor
    (``min_retained_solo_pause_sec``, default 0.55s).
    """
    tighten = defaults.get("tighten", {})
    turn_floor = float(tighten.get("min_retained_pause_sec", 0.18))
    solo_floor = float(tighten.get("min_retained_solo_pause_sec", 0.55))
    if solo_floor < turn_floor:
        solo_floor = turn_floor
    if _peer_speaking_in_gap(project, track_id, gap_start, gap_end, peer_indexes):
        return turn_floor, False
    return solo_floor, True


def _collect_filler_candidates(
    words: list[TranscriptWord],
    track_id: str,
    tighten: dict[str, Any],
    *,
    skip_counts: dict[str, int] | None = None,
) -> list[_CutCandidate]:
    """Lexicon filler hits that pass cluster + discourse-safe gates (read-only)."""
    fillers = {normalize_text(w) for w in tighten.get("filler_words", []) if str(w).strip()}
    min_cluster = int(tighten.get("min_filler_cluster", 2))
    cluster_gap_sec = bounded_float(tighten.get("filler_cluster_gap_sec", 2.0), 2.0, 0.0, 60.0)
    discourse = _discourse_marker_set(tighten)
    pause_sec = bounded_float(
        tighten.get("discourse_pause_sec", DEFAULT_DISCOURSE_PAUSE_SEC),
        DEFAULT_DISCOURSE_PAUSE_SEC,
        0.0,
        _DISCOURSE_PAUSE_SEC_MAX,
    )
    confidence_max = bounded_float(
        tighten.get("discourse_confidence_max", DEFAULT_DISCOURSE_CONFIDENCE_MAX),
        DEFAULT_DISCOURSE_CONFIDENCE_MAX,
        0.0,
        1.0,
    )
    candidates: list[_CutCandidate] = []
    hits = _lexicon_phrase_hits(words, fillers)
    for group in _cluster_lexicon_hits(words, hits, cluster_gap_sec=cluster_gap_sec):
        meets_cluster = min_cluster <= 1 or len(group) >= min_cluster
        if not meets_cluster:
            for _start_i, _end_i, token in group:
                if token in discourse:
                    _count_skip(skip_counts, f"discourse:{token}")
            continue
        for gi, (start_i, end_i, token) in enumerate(group):
            keep = token not in discourse or (
                _adjacent_true_disfluency(words, group, gi, discourse)
                or _adjacent_repeat(words, group, gi)
                or _pause_bounded_span(words, start_i, end_i, pause_sec)
                or _low_discourse_confidence_span(words, start_i, end_i, confidence_max)
            )
            if keep:
                candidates.append(
                    _CutCandidate(
                        track_id=track_id,
                        start=words[start_i].start,
                        end=words[end_i].end,
                        reason=f"filler:{token}",
                        cut_kind="filler",
                        filler_confidence=_span_confidence(words, start_i, end_i),
                    )
                )
            else:
                _count_skip(skip_counts, f"discourse:{token}")
    return candidates


def _collect_candidates(
    transcript: Transcript,
    defaults: dict[str, Any],
    *,
    project: EpisodeProject | None = None,
    skip_counts: dict[str, int] | None = None,
    peer_indexes: dict[str, _PeerTrackSpeechIndex] | None = None,
) -> list[_CutCandidate]:
    """Find filler-cluster, repetition, and long-pause candidates (read-only).

    Acoustic gap candidates need decoded audio; add them with
    :func:`_add_acoustic_candidates`.
    """
    tighten = defaults.get("tighten", {})
    max_pause = float(tighten.get("max_pause_sec", 1.2))
    track_id = transcript.track_id
    skip_pauses = _edit_mode(tighten) == "mute"

    words = transcript.words
    candidates = _collect_filler_candidates(words, track_id, tighten, skip_counts=skip_counts)
    if bool(tighten.get("repetition_candidates", True)):
        candidates.extend(_collect_repetition_candidates(words, track_id, tighten))
    for i, word in enumerate(words):
        if word.suppressed:
            continue
        if i + 1 < len(words) and not words[i + 1].suppressed and not skip_pauses:
            gap = words[i + 1].start - word.end
            if gap >= max_pause and gap > 0:
                gap_start, gap_end = word.end, words[i + 1].start
                if project is not None:
                    # A ripple delete leaves no clip over the deleted source range,
                    # so a source-clock gap can span material the listener never
                    # hears any more. Measure what actually remains on the timeline
                    # before proposing a cut sized off the (possibly much larger)
                    # source gap.
                    gap = _timeline_pause_gap_sec(project, track_id, gap_start, gap_end)
                    if gap < max_pause:
                        continue
                    retain, solo = _retained_pause_floor_sec(
                        project, track_id, gap_start, gap_end, defaults, peer_indexes
                    )
                    trim_end = _pause_trim_end_for_timeline_floor(
                        project, track_id, gap_start, gap_end, retain
                    )
                else:
                    retain = float(tighten.get("min_retained_pause_sec", 0.18))
                    solo = False
                    trim_end = words[i + 1].start - retain
                if trim_end is not None and trim_end > word.end + 0.02:
                    tag = f"pause:{gap:.2f}s"
                    if solo:
                        tag = f"{tag}:solo"
                    candidates.append(
                        _CutCandidate(
                            track_id=track_id,
                            start=word.end,
                            end=trim_end,
                            reason=tag,
                            cut_kind="pause",
                            max_end=trim_end,
                        )
                    )
    return sorted(candidates, key=_candidate_order)


# Acoustic runs keep this much air next to each flanking ASR word, and waveform
# snapping / breath handling may move the cut at most ``_RUN_PAD`` past the run.
_ACOUSTIC_EDGE_MARGIN_SEC = 0.025
_ACOUSTIC_RUN_PAD_SEC = 0.05
_ACOUSTIC_MIN_CUT_SEC = 0.1


@dataclass(frozen=True)
class _PeerSpeechIndex:
    """One sorted speech sweep with the two longest distinct-track prefixes."""

    starts: tuple[float, ...]
    first: tuple[tuple[str | None, float], ...]
    second: tuple[tuple[str | None, float], ...]

    @classmethod
    def build(cls, spans: Iterable[tuple[float, float, str]]) -> _PeerSpeechIndex:
        # Match the direct guard's two boundary checks, including point words.
        ordered = sorted((start, end, track_id) for start, end, track_id in spans)
        first_track: str | None = None
        second_track: str | None = None
        first_end = second_end = float("-inf")
        first: list[tuple[str | None, float]] = []
        second: list[tuple[str | None, float]] = []
        for _start, end, track_id in ordered:
            if track_id == first_track:
                first_end = max(first_end, end)
            elif track_id == second_track:
                second_end = max(second_end, end)
                if second_end > first_end:
                    first_track, second_track = second_track, first_track
                    first_end, second_end = second_end, first_end
            elif end > first_end:
                second_track, second_end = first_track, first_end
                first_track, first_end = track_id, end
            elif end > second_end:
                second_track, second_end = track_id, end
            first.append((first_track, first_end))
            second.append((second_track, second_end))
        return cls(tuple(start for start, _end, _track in ordered), tuple(first), tuple(second))

    def overlaps_except(self, track_id: str, start: float, end: float) -> bool:
        if end <= start:
            return False
        before = bisect_left(self.starts, end)
        if before == 0:
            return False
        first_track, first_end = self.first[before - 1]
        if first_track == track_id:
            return self.second[before - 1][1] > start
        return first_end > start


@dataclass(frozen=True)
class _PeerTrackSpeechIndex:
    shared: _PeerSpeechIndex
    track_id: str

    def overlaps(self, start: float, end: float) -> bool:
        return self.shared.overlaps_except(self.track_id, start, end)


def _peer_speech_indexes(project: EpisodeProject) -> dict[str, _PeerTrackSpeechIndex]:
    from podcast_mcp.models import TrackRole

    dialogue_ids = {track.id for track in project.tracks if track.role == TrackRole.DIALOGUE}
    shared = _PeerSpeechIndex.build(
        (float(w.start), float(w.end), tr.track_id)
        for tr in project.transcripts
        if tr.track_id in dialogue_ids
        for w in tr.words
        if not w.suppressed
    )
    return {tr.track_id: _PeerTrackSpeechIndex(shared, tr.track_id) for tr in project.transcripts}


def _acoustic_scan_gaps(
    words: list[TranscriptWord], cfg: AcousticGapConfig
) -> Iterator[tuple[TranscriptWord, TranscriptWord]]:
    """Adjacent live word pairs whose gap is long enough to scan."""
    for word, nxt in pairwise(words):
        if word.suppressed or nxt.suppressed or word.end <= word.start or nxt.end <= nxt.start:
            continue
        if nxt.start - word.end >= cfg.min_gap_sec:
            yield word, nxt


def _flanking_speech_rms(
    audio_cache: TrackAudioCache,
    word: TranscriptWord,
    nxt: TranscriptWord,
    defaults: dict[str, Any],
) -> float | None:
    """Use the quieter of two short word windows as local speech context."""
    audibility_db = float(
        defaults.get("analysis", {}).get("heuristics", {}).get("audibility_rms_db", -42.0)
    )
    floor = db_to_amplitude(audibility_db)
    windows = (
        audio_cache.window(max(word.start, word.end - 0.2), word.end),
        audio_cache.window(nxt.start, min(nxt.end, nxt.start + 0.2)),
    )
    levels: list[float] = []
    for samples in windows:
        if not samples.size or not np.all(np.isfinite(samples)):
            return None
        level = float(np.sqrt(np.mean(samples**2)))
        if not math.isfinite(level) or level <= floor:
            return None
        levels.append(level)
    return min(levels)


def _collect_acoustic_candidates(
    words: list[TranscriptWord],
    track_id: str,
    cfg: AcousticGapConfig,
    audio_cache: TrackAudioCache,
    occupied: HalfOpenIntervalIndex,
    *,
    defaults: dict[str, Any] | None = None,
    project: EpisodeProject | None = None,
    skip_counts: dict[str, int] | None = None,
    peer_indexes: dict[str, _PeerTrackSpeechIndex] | None = None,
) -> list[_CutCandidate]:
    """Review-only ``filler:acoustic`` candidates for voiced runs in owner gaps."""
    candidates: list[_CutCandidate] = []
    for word, nxt in _acoustic_scan_gaps(words, cfg):
        gap_start, gap_end = word.end, nxt.start
        if _word_not_owner(word, track_id) or _word_not_owner(nxt, track_id):
            _count_skip(skip_counts, "acoustic:not_owner")
            continue
        # A peer speaking in the gap makes voiced energy here most likely bleed.
        if project is not None and _peer_speaking_in_gap(
            project, track_id, gap_start, gap_end, peer_indexes
        ):
            _count_skip(skip_counts, "acoustic:peer_speaking")
            continue
        reference = _flanking_speech_rms(audio_cache, word, nxt, defaults or {})

        def count_breath_rejection() -> None:
            _count_skip(skip_counts, "acoustic:breath")

        runs = find_voiced_gap_runs(
            audio_cache,
            gap_start,
            gap_end,
            min_gap_sec=cfg.min_gap_sec,
            max_run_sec=cfg.max_run_sec,
            max_frames=cfg.max_frames,
            vad_backend=cfg.vad_backend,
            defaults=defaults,
            speech_reference_rms=reference,
            on_breath_rejected=count_breath_rejection,
        )
        lo, hi = gap_start + _ACOUSTIC_EDGE_MARGIN_SEC, gap_end - _ACOUSTIC_EDGE_MARGIN_SEC
        for run in runs:
            start, end = max(lo, run.start), min(hi, run.end)
            if end - start < _ACOUSTIC_MIN_CUT_SEC:
                _count_skip(skip_counts, "acoustic:edge_margin")
                continue
            if occupied.overlaps(start, end):
                _count_skip(skip_counts, "acoustic:occupied")
                continue
            candidates.append(
                _CutCandidate(
                    track_id=track_id,
                    start=start,
                    end=end,
                    reason=ACOUSTIC_FILLER_REASON,
                    cut_kind="filler",
                    filler_confidence=run.confidence,
                    min_start=max(lo, start - _ACOUSTIC_RUN_PAD_SEC),
                    max_end=min(hi, end + _ACOUSTIC_RUN_PAD_SEC),
                    review_only=True,
                )
            )
    return candidates


def _add_acoustic_candidates(
    candidates: list[_CutCandidate],
    transcript: Transcript,
    defaults: dict[str, Any],
    *,
    project: EpisodeProject | None = None,
    audio_cache: TrackAudioCache | None = None,
    skip_counts: dict[str, int] | None = None,
    peer_indexes: dict[str, _PeerTrackSpeechIndex] | None = None,
) -> list[_CutCandidate]:
    """``candidates`` plus acoustic gap candidates when enabled and audio decoded."""
    cfg = AcousticGapConfig.from_tighten(defaults.get("tighten"))
    if not cfg.enabled:
        return candidates
    if audio_cache is None:
        # Decode failures are only logged at debug level; surface the skipped
        # scan when there was something to scan.
        if next(_acoustic_scan_gaps(transcript.words, cfg), None) is not None:
            _count_skip(skip_counts, "acoustic:no_audio")
        return candidates
    occupied = HalfOpenIntervalIndex.build(
        (c.start, c.end) for c in candidates if c.cut_kind != "pause"
    )
    extra = _collect_acoustic_candidates(
        transcript.words,
        transcript.track_id,
        cfg,
        audio_cache,
        occupied,
        defaults=defaults,
        project=project,
        skip_counts=skip_counts,
        peer_indexes=peer_indexes,
    )
    if not extra:
        return candidates
    return sorted([*candidates, *extra], key=_candidate_order)


def _resolve_analyzed_cuts(
    candidates: list[_CutCandidate],
    results: list[_AnalyzedCut | None],
    *,
    existing: Iterable[EditDecision] = (),
    skip_counts: dict[str, int] | None = None,
) -> list[_AnalyzedCut]:
    """Resolve overlaps between analyzed cuts, preserving candidate order.

    Runs after analysis so it sees final (post-pacing) spans:

    * A cut overlapping an already *applied* decision in ``existing`` on the
      same track is dropped: applying does not suppress transcript words, so
      re-proposal would otherwise stack a pending duplicate over approved audio
      (coalescing never merges across ``applied``).
    * A strictly bounded (acoustic) cut overlapping a surviving word-based cut on
      the same track is dropped -- pacing may have widened ``filler:um`` across
      the gap.
    * A pause trim is replaced only by an acoustic cut that *survived* analysis;
      when the acoustic candidate is rejected the pause trim still stands.
    """
    applied_spans: dict[str, list[tuple[float, float]]] = {}
    for decision in existing:
        if decision.applied:
            applied_spans.setdefault(decision.track_id, []).append((decision.start, decision.end))
    applied_index = {
        tid: HalfOpenIntervalIndex.build(spans) for tid, spans in applied_spans.items()
    }
    pairs: list[tuple[_CutCandidate, _AnalyzedCut | None]] = []
    for candidate, result in zip(candidates, results, strict=True):
        index = applied_index.get(candidate.track_id)
        if result is not None and index is not None and index.overlaps(result.start, result.end):
            _count_skip(skip_counts, "applied_overlap")
            result = None
        pairs.append((candidate, result))
    word_spans: dict[str, list[tuple[float, float]]] = {}
    for candidate, result in pairs:
        if result is not None and candidate.cut_kind != "pause" and not candidate.strictly_bounded:
            word_spans.setdefault(candidate.track_id, []).append((result.start, result.end))
    word_index = {tid: HalfOpenIntervalIndex.build(spans) for tid, spans in word_spans.items()}

    dropped: set[int] = set()
    bounded_spans: dict[str, list[tuple[float, float]]] = {}
    for idx, (candidate, result) in enumerate(pairs):
        if not candidate.strictly_bounded:
            continue
        if result is None:
            _count_skip(skip_counts, "acoustic:rejected")
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
    return [
        result
        for idx, (_candidate, result) in enumerate(pairs)
        if result is not None and idx not in dropped
    ]


# A word's voice may run this far past its transcript time before a pause or
# filler edge stops following it and the span is reviewed instead (Whisper places
# soft onsets up to ~0.5 s late; see edits/join_speech.py).
_EDGE_NUDGE_MAX_SEC = 0.5
# Air kept between a word's voice edge and the cut edge, as join_speech suggests for
# existing clip edges. On the lab tape the 45 ms join-gate window then sits below the
# inaudible-splice floor instead of on the word's decay.
_VOICE_EDGE_PAD_SEC = 0.06
_INTERIOR_SPEECH_MIN_SEC = 0.1
_MIN_NUDGED_CUT_SEC = 0.1


@dataclass(frozen=True)
class _VoicedSpeechCheck:
    start: float
    end: float
    # ``interior_speech``: the span holds voice the ripple would delete (a pause's
    # own track, or any track a session cut removes the window from).
    # ``interior_audio``: a pause span is not dead air on every track it ripples.
    # ``voiced_edge``: an edge sits in kept voice and no in-bounds nudge frees it.
    flag: str | None = None


def _accept_nudge(
    candidate: _CutCandidate, before: tuple[float, float], start: float, end: float
) -> tuple[float, float] | None:
    """``(start, end)`` when the nudged span is one this candidate may still propose."""
    if abs(start - before[0]) > _EDGE_NUDGE_MAX_SEC or abs(end - before[1]) > _EDGE_NUDGE_MAX_SEC:
        return None
    if _clamp_to_candidate(candidate, start, end) != (start, end):
        return None
    if end - start < _MIN_NUDGED_CUT_SEC:
        return None
    if candidate.cut_kind != "pause" and not _cut_covers_reparandum(candidate, start, end):
        return None
    return start, end


def _check_voiced_speech(
    candidate: _CutCandidate,
    cut_start: float,
    cut_end: float,
    *,
    audio_cache: TrackAudioCache,
    word_index: CutWordIndex,
    defaults: dict[str, Any],
    peer_caches: Sequence[TrackAudioCache] = (),
) -> _VoicedSpeechCheck:
    """Move each cut edge out of kept voice; flag speech the cut would swallow.

    An edge inside a voiced run is nudged to the run's edge: past the run (plus a
    little air) when the run belongs to a word that stays, so the word keeps its
    tail or onset; to the run's own edge when it is the cut word's voice that the
    transcript timed short. Word times are the only view the candidate had, and
    on the lab tape aligned and Whisper ends both sit 120-270 ms inside the voice.
    A kept-word nudge the candidate's bounds or coverage rule refuse leaves the
    edge where it is and marks the cut for review.

    ``peer_caches`` are the other dialogue tracks a session ripple removes the
    same window from. Everything on a peer stays, so a peer run at an edge is
    always a kept-word nudge, and a peer run inside the span is speech the ripple
    deletes whatever the cut's kind. A pause must also be dead air on every track
    it ripples: audible frames the pitch probe cannot vouch for (a fricative, a
    click, a laugh) still make it a review.
    """
    floor = float(
        defaults.get("analysis", {}).get("heuristics", {}).get("audibility_rms_db", -42.0)
    )
    reach = _EDGE_NUDGE_MAX_SEC + _VOICE_EDGE_PAD_SEC + FRAME_SEC
    window_lo, window_hi = cut_start - reach, cut_end + reach
    own_runs = voiced_runs(audio_cache, window_lo, window_hi, floor_db=floor)
    peer_runs = [voiced_runs(c, window_lo, window_hi, floor_db=floor) for c in peer_caches]
    span_lo = min(candidate.start, cut_start)
    span_hi = max(candidate.end, cut_end)

    def kept_word_in(lo: float, hi: float) -> bool:
        # A run cut off by the window may go on into a word the window never saw.
        if lo <= window_lo + FRAME_SEC:
            lo = -math.inf
        if hi >= window_hi - FRAME_SEC:
            hi = math.inf
        return word_index.kept_word_overlaps(lo, hi, exclude_start=span_lo, exclude_end=span_hi)

    # Only a refused kept-word shrink is a defect worth a reviewer's ear; a cut word
    # whose own voice runs past its transcript time keeps the status quo edge.
    stuck = False
    for runs, own in ((own_runs, True), *((runs, False) for runs in peer_runs)):
        run = run_straddling(runs, cut_start)
        if run is not None:
            kept = not own or kept_word_in(run[0], cut_start)
            target = run[1] + _VOICE_EDGE_PAD_SEC if kept else run[0]
            nudged = _accept_nudge(candidate, (cut_start, cut_end), target, cut_end)
            if nudged is not None:
                cut_start = nudged[0]
            elif kept:
                stuck = True
        run = run_straddling(runs, cut_end)
        if run is not None:
            kept = not own or kept_word_in(cut_end, run[1])
            target = run[0] - _VOICE_EDGE_PAD_SEC if kept else run[1]
            nudged = _accept_nudge(candidate, (cut_start, cut_end), cut_start, target)
            if nudged is not None:
                cut_end = nudged[1]
            elif kept:
                stuck = True
    deleted = [*peer_runs, *([own_runs] if candidate.cut_kind == "pause" else [])]
    if any(
        voiced_sec_inside(runs, cut_start, cut_end) >= _INTERIOR_SPEECH_MIN_SEC for runs in deleted
    ):
        return _VoicedSpeechCheck(cut_start, cut_end, "interior_speech")
    if candidate.cut_kind == "pause" and any(
        voiced_sec_inside(audible_runs(c, cut_start, cut_end, floor_db=floor), cut_start, cut_end)
        >= _INTERIOR_SPEECH_MIN_SEC
        for c in (audio_cache, *peer_caches)
    ):
        return _VoicedSpeechCheck(cut_start, cut_end, "interior_audio")
    return _VoicedSpeechCheck(cut_start, cut_end, "voiced_edge" if stuck else None)


def _analyze_candidate(
    project: EpisodeProject,
    candidate: _CutCandidate,
    defaults: dict[str, Any],
    *,
    audio_cache: TrackAudioCache | None = None,
    speaker_context: _SpeakerCutContext | None = None,
    word_index: CutWordIndex | None = None,
    peer_indexes: dict[str, _PeerTrackSpeechIndex] | None = None,
    audio_caches: Mapping[str, TrackAudioCache] | None = None,
) -> _AnalyzedCut | None:
    """Waveform-optimize, risk-assess, and fade-size one candidate. Read-only w.r.t.
    project (no mutation) -- safe to call from multiple threads concurrently, as
    long as each call gets its own jump-measurement cache (below); audio_cache
    (one per track, decoded once) is read-only and safe to share across threads.
    ``audio_caches`` holds the other dialogue tracks' decodes for the voiced-speech
    check of a session ripple; a track absent from it is not checked.
    """
    tighten = defaults.get("tighten", {})
    leave_in = bool(tighten.get("leave_in_if_risky", True))
    track_id = candidate.track_id
    # Fresh per-candidate cache: assess_cut_risk and recommend_cut_fade_ms both
    # measure the join jump at the same boundaries in the common case (no breath
    # extension moved them) -- share one measurement instead of taking it twice.
    jump_cache: dict[tuple[str, float], float | None] = {}

    opt, risk = optimize_and_assess(
        project,
        track_id,
        candidate.start,
        candidate.end,
        filler_confidence=candidate.filler_confidence,
        defaults=defaults,
        cache=jump_cache,
        audio_cache=audio_cache,
        word_index=word_index,
    )
    cut_start, cut_end = opt.start, opt.end
    if candidate.strictly_bounded:
        # Acoustic evidence is local to the inter-word gap; waveform snapping
        # must never expand it back onto an ASR word.
        snapped = _clamp_to_candidate(candidate, cut_start, cut_end)
        if snapped is None:
            return None
        cut_start, cut_end = snapped

    breaths = detect_adjacent_breath(
        project, track_id, cut_start, cut_end, defaults=defaults, audio_cache=audio_cache
    )
    extended = _clamp_to_candidate(candidate, *extend_cut_for_breaths(cut_start, cut_end, breaths))
    if extended is None:
        return None
    cut_start, cut_end = extended

    if _cut_span_is_bleed_not_owner(
        project,
        track_id,
        cut_start,
        cut_end,
        speaker_context=speaker_context,
        word_index=word_index,
    ):
        return None

    paced = apply_filler_pacing(
        project,
        track_id,
        cut_start,
        cut_end,
        defaults=defaults,
        cut_kind=candidate.cut_kind,
        # Bounded candidates never widen onto the rest of the gap or get a pad,
        # so the pause left behind is never longer than the original.
        allow_gap_expand=not candidate.strictly_bounded,
    )
    if paced is None:
        return None
    paced_span = _clamp_to_candidate(candidate, paced.start, paced.end)
    if paced_span is None:
        return None
    cut_start, cut_end = paced_span
    from podcast_mcp.edits.speech_energy_guard import resolve_cut_scope

    try:
        scope, guard = resolve_cut_scope(
            project,
            track_id,
            cut_start,
            cut_end,
            defaults=defaults,
        )
    except ValueError:
        return None
    if guard is not None and guard.blocked and candidate.cut_kind == "pause":
        # A peer is audibly speaking over this gap, so the guard forces a
        # track-local punch instead of a session ripple. A punch leaves a
        # silent hole on this track only -- the peer's track still spans
        # the same window, so the timeline does not get any shorter. A
        # pause proposal exists only to shorten the timeline, so it is
        # useless (and confusing to review) once it can't.
        return None
    voiced_flag: str | None = None
    if audio_cache is not None:
        peer_caches: list[TrackAudioCache] = []
        if scope == "session" and audio_caches:
            peer_caches = [
                audio_caches[tid]
                for tid in dialogue_track_ids(project)
                if tid != track_id and tid in audio_caches
            ]
        voiced = _check_voiced_speech(
            candidate,
            cut_start,
            cut_end,
            audio_cache=audio_cache,
            word_index=word_index or CutWordIndex.build(project, track_id),
            defaults=defaults,
            peer_caches=peer_caches,
        )
        cut_start, cut_end, voiced_flag = voiced.start, voiced.end, voiced.flag
    if candidate.cut_kind in ("repeat", "restart") and not _cut_covers_reparandum(
        candidate, cut_start, cut_end
    ):
        return None
    if candidate.strictly_bounded and (cut_start, cut_end) != (opt.start, opt.end):
        # Risk was measured on the optimized span; re-assess the span we cut.
        risk = assess_cut_risk(
            project,
            track_id,
            cut_start,
            cut_end,
            filler_confidence=candidate.filler_confidence,
            boundary_confidence=opt.confidence,
            defaults=defaults,
            cache=jump_cache,
            audio_cache=audio_cache,
            word_index=word_index,
        )

    reason = candidate.reason
    # Repetition/restart detection and acoustic-only gap fillers are
    # intentionally proposal-only.  Even an exact token repeat can be emphasis
    # ("very very"), a phrase restart can change meaning if the repair is
    # mistaken for the reparandum, and voiced energy in an ASR gap may be a
    # breath, laugh, or missed word rather than a filler.
    review_required = candidate.review_only or candidate.cut_kind in {"repeat", "restart"}
    if voiced_flag is not None:
        review_required = True
        reason = f"{reason}:{voiced_flag}"
    replace_gap = paced.replace_gap_sec
    # Contiguous retain before the next word can be shorter than the floor when
    # prior ripples punched holes; pad the shortfall with silence after ripple.
    if candidate.cut_kind == "pause" and replace_gap is None:
        nxt_start = None
        if word_index is not None:
            nxt_start = word_index.next_start(project, track_id, cut_end - 1e-6, audible=True)
        else:
            tr = project.transcript_for_track(track_id)
            if tr:
                for w in tr.words:
                    if w.suppressed or w.end <= w.start:
                        continue
                    if w.start + 1e-6 >= cut_end:
                        nxt_start = w.start
                        break
        if nxt_start is not None and nxt_start > cut_end:
            floor, _solo = _retained_pause_floor_sec(
                project, track_id, cut_start, nxt_start, defaults, peer_indexes
            )
            retain_start, retain_end = _contiguous_retain_before_word(
                project, track_id, cut_end, nxt_start
            )
            contiguous = max(0.0, retain_end - max(retain_start, cut_end))
            shortfall = floor - contiguous
            if shortfall > 0.05:
                replace_gap = shortfall
    if guard is not None and guard.blocked:
        peers = ",".join(guard.blocking_track_ids)
        if guard.action == "review":
            review_required = True
            reason = f"{reason}:other_speaking:{peers}"
        else:
            reason = f"{reason}:track_local:{peers}"
        replace_gap = None
        scope = "track"

    if risk.too_risky:
        if leave_in:
            return None
        review_required = True
        reason = f"{reason}:risky"

    if bool(tighten.get("join_continuity_gate", False)):
        try:
            from dataclasses import replace

            from podcast_mcp.edits.join_continuity import (
                JoinContinuityConfig,
                assess_proposed_cut,
            )

            jc_cfg = replace(
                JoinContinuityConfig.from_defaults(defaults),
                neural=False,
                calibrate=False,
            )
            jc = assess_proposed_cut(
                project,
                track_id,
                cut_start,
                cut_end,
                timebase="source",
                config=jc_cfg,
                defaults=defaults,
                audio_caches={track_id: audio_cache} if audio_cache is not None else None,
            )
            if jc.verdict == "fail":
                return None
            if jc.verdict == "review":
                review_required = True
                reason = f"{reason}:join_review"
        except Exception as exc:
            # Scorer/infra errors: do not discard the cut; existing risk gate remains.
            log.debug("join continuity scoring skipped: %s", exc)

    fade_ms = recommend_cut_fade_ms(
        project,
        track_id,
        cut_start,
        cut_end,
        cut_kind=candidate.cut_kind,
        defaults=defaults,
        cache=jump_cache,
        audio_cache=audio_cache,
    )
    mute_mode = _edit_mode(tighten) == "mute"
    if mute_mode:
        from podcast_mcp.edits.mute_regions import MUTE_FADE_SEC

        fade_ms = min(fade_ms, round(MUTE_FADE_SEC * 1000))
        replace_gap = None
    return _AnalyzedCut(
        track_id=track_id,
        start=cut_start,
        end=cut_end,
        reason=reason,
        review_required=review_required,
        crossfade_ms=fade_ms,
        cut_confidence=opt.confidence,
        boundary_mode=opt.mode,
        replace_gap_sec=replace_gap,
        scope=scope,
        decision_type="mute" if mute_mode else "remove",
    )


def _apply_analyzed_cut(project: EpisodeProject, result: _AnalyzedCut) -> EditDecision:
    """Append the edit decision for one already-analyzed cut (mutates project)."""
    decision_type = (
        EditDecisionType.MUTE if result.decision_type == "mute" else EditDecisionType.REMOVE
    )
    return append_remove_decision(
        project,
        result.track_id,
        result.start,
        result.end,
        reason=result.reason,
        review_required=result.review_required,
        crossfade_ms=result.crossfade_ms,
        cut_confidence=result.cut_confidence,
        boundary_mode=result.boundary_mode,
        replace_gap_sec=result.replace_gap_sec,
        scope=result.scope,
        decision_type=decision_type,
    )


def analyze_fillers_and_pauses(
    project: EpisodeProject,
    transcript: Transcript,
    defaults: dict[str, Any],
    *,
    skip_counts: dict[str, int] | None = None,
) -> list[EditDecision]:
    """Serial, single-transcript entry point (kept for direct/standalone callers
    and tests). The pipeline's hot path (propose_tighten_edits in edits/tighten.py)
    instead flattens candidates across ALL transcripts and analyzes them in
    parallel before applying decisions serially -- see that module for why.

    Still builds a decode-once audio cache for this one track (see
    edits/audio_cache.py) so direct callers get the same speedup as the pipeline
    path, just without cross-track parallelism.

    Resolves ``tighten.intensity`` the same way (:func:`~podcast_mcp.edits.tighten_intensity.with_tighten_intensity`).
    """
    defaults = with_tighten_intensity(defaults)
    peer_indexes = _peer_speech_indexes(project)
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
        skip_counts=skip_counts,
        peer_indexes=peer_indexes,
    )
    speaker_context = _speaker_cut_context(project) if candidates else None
    word_index = CutWordIndex.build(project, transcript.track_id) if candidates else None
    results = [
        _analyze_candidate(
            project,
            candidate,
            defaults,
            audio_cache=audio_cache,
            speaker_context=speaker_context,
            word_index=word_index,
            peer_indexes=peer_indexes,
            audio_caches=audio_caches,
        )
        for candidate in candidates
    ]
    resolved = _resolve_analyzed_cuts(
        candidates, results, existing=list(project.edit_decisions), skip_counts=skip_counts
    )
    return [_apply_analyzed_cut(project, result) for result in resolved]
