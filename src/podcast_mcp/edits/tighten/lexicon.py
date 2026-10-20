"""Filler lexicon matching and discourse-marker demotion."""

from __future__ import annotations

from collections.abc import Iterable
from typing import TYPE_CHECKING, Any

from podcast_mcp.models import (
    TranscriptWord,
)
from podcast_mcp.util.text import lexicon_form

if TYPE_CHECKING:
    pass


# Discourse markers stay in `tighten.filler_words` but are demoted: they become
# cut candidates only with an adjacent true disfluency/repeat, a pause bound, or
# low ASR confidence. Defaults match `.agents/defaults/pipeline.yaml`.
# Missing `discourse_markers` uses these defaults; explicit `[]` disables demotion.
DEFAULT_DISCOURSE_MARKERS = ("like", "you know", "sort of", "kind of")


DEFAULT_DISCOURSE_PAUSE_SEC = 0.35


DEFAULT_DISCOURSE_CONFIDENCE_MAX = 0.6


_DISCOURSE_PAUSE_SEC_MAX = 5.0


_SUBJECT_PRONOUNS = frozenset(
    {
        "i",
        "i'm",
        "i've",
        "i'd",
        "i'll",
        "you",
        "you're",
        "you've",
        "we",
        "we're",
        "we've",
        "he",
        "he's",
        "she",
        "she's",
        "they",
        "they're",
        "they've",
        "it",
        "it's",
    }
)


# A marker followed by one of these words is content, never filler: "like I'm
# doing" compares, "I was like, I'm done" quotes. Owner-confirmed on the lab
# recording (Audra 821.78, 2026-10-05), where ASR confidence alone said cut.
_CONTENT_USE_FOLLOWERS: dict[str, frozenset[str]] = {"like": _SUBJECT_PRONOUNS}


_LexiconHit = tuple[int, int, str]


def _lexicon(entries: Iterable[Any]) -> set[str]:
    """Config lexicon entries in :func:`lexicon_form`, the form ASR words are compared in."""
    return {form for entry in entries if (form := lexicon_form(str(entry)))}


def _lexicon_phrase_hits(
    words: list[TranscriptWord], lexicon: set[str], *, include_suppressed: bool = False
) -> list[_LexiconHit]:
    """Greedy left-to-right longest contiguous lexicon matches.

    Words compare in :func:`lexicon_form` (``Um.`` matches ``um``), and multi-word
    entries (``you know``, ``uh huh``) match split ASR tokens, including a
    zero-length second token (``Uh`` + ``-huh.``). ``lexicon`` must already be in
    that form (:func:`_lexicon`). A hit can have zero length; callers that cut
    one drop it. Suppressed words are skipped unless ``include_suppressed``.
    """
    if not lexicon:
        return []
    phrase_lens = sorted({len(p.split()) for p in lexicon}, reverse=True)
    kept = [(i, w) for i, w in enumerate(words) if include_suppressed or not w.suppressed]
    if not kept:
        return []
    norms = [lexicon_form(w.text) for _, w in kept]
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


def _backchannel_set(tighten: dict[str, Any]) -> set[str]:
    """Acknowledgments (``uh huh``, ``mm-hmm``) that are speech, never filler cuts."""
    return _lexicon(tighten.get("backchannels") or [])


def _discourse_marker_set(tighten: dict[str, Any]) -> set[str]:
    if "discourse_markers" not in tighten:
        raw: list[Any] = list(DEFAULT_DISCOURSE_MARKERS)
    else:
        raw = list(tighten.get("discourse_markers") or [])
    return _lexicon(raw)


def lexicon_tokens(tighten: dict[str, Any]) -> frozenset[str]:
    """Every token of the filler, backchannel and discourse lexicons, one ASR word each.

    ASR splits entries across words (``uh huh`` -> ``Uh`` + ``-huh.``), so a token
    matches one word in :func:`lexicon_form`.
    """
    entries = (
        _lexicon(tighten.get("filler_words", []))
        | _backchannel_set(tighten)
        | _discourse_marker_set(tighten)
    )
    return frozenset(token for entry in entries for token in entry.split())


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


def _content_use(words: list[TranscriptWord], end_i: int, token: str) -> bool:
    followers = _CONTENT_USE_FOLLOWERS.get(token)
    nxt = _next_nonsuppressed(words, end_i)
    return followers is not None and nxt is not None and lexicon_form(words[nxt].text) in followers


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
