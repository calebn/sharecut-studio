"""Word-span plausibility: trim ASR words stretched across silence (#979).

Whisper and the forced aligner both stretch a word across digital silence on a gated
track to reach the next sound (a 5.84 s ``-huh.``, a 5.98 s ``Uh``). Cuts, peer-speaking
checks and audibility all trust word spans, so a word longer than its token class can
last is trimmed onto the voiced audio of its own recording.

The stretch runs back from the word's end: on the lab recording the aligner's ``Uh``
ends inside its real audio and Whisper's ``-huh.`` ends 40 ms before it, while both
start at an earlier sound. So the trimmed span is the voiced run(s) nearest the end
that fit inside the cap, or, with no voiced audio inside the span, the last ``cap``
seconds of it. Either way the new span lies inside the
old one, so word order and neighbours are never disturbed, and it is no longer than the
cap, so a second pass changes nothing.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.audio_cache import WAVEFORM_SAMPLE_RATE
from podcast_mcp.edits.fillers import lexicon_tokens
from podcast_mcp.edits.voiced_runs import VoicedRun, voiced_runs
from podcast_mcp.engines.audio_audit import AnalysisPolicy, TrackRmsCache
from podcast_mcp.engines.transcribe import dialogue_transcribe_jobs
from podcast_mcp.models import EpisodeProject, TranscriptWord
from podcast_mcp.util.text import lexicon_form

log = logging.getLogger(__name__)

# Trimmed spans land on float sums of the cap; this keeps a re-run from re-trimming them.
_EPS_SEC = 1e-6


@dataclass(frozen=True)
class WordSpanCaps:
    """The longest plausible span per token class; a cap at or below 0 never trims."""

    short_tokens: frozenset[str]
    short_sec: float
    word_sec: float
    floor_db: float

    @classmethod
    def from_defaults(cls, defaults: dict[str, Any]) -> WordSpanCaps:
        pol = AnalysisPolicy.from_defaults(defaults)
        return cls(
            short_tokens=lexicon_tokens(defaults.get("tighten", {})),
            short_sec=pol.max_short_token_sec,
            word_sec=pol.max_word_audibility_sec,
            floor_db=pol.audibility_rms_db,
        )

    def cap_for(self, word: TranscriptWord) -> float:
        return self.short_sec if lexicon_form(word.text) in self.short_tokens else self.word_sec

    def is_implausible(self, word: TranscriptWord) -> bool:
        cap = self.cap_for(word)
        return not word.ignored and cap > 0 and word.end - word.start > cap + _EPS_SEC


def plausible_span(
    start: float, end: float, cap: float, runs: Sequence[VoicedRun]
) -> tuple[float, float]:
    """The part of ``[start, end]`` a word of at most ``cap`` seconds really occupies."""
    inside = [(max(a, start), min(b, end)) for a, b in runs if a < end and b > start]
    if not inside:
        return max(start, end - cap), end
    lo, hi = inside[-1]
    if hi - lo > cap:
        return hi - cap, hi
    for run_start, _ in reversed(inside[:-1]):
        if hi - run_start > cap:
            break
        lo = run_start
    return lo, hi


def trim_implausible_words(
    words: Sequence[TranscriptWord], audio: TrackRmsCache, caps: WordSpanCaps
) -> int:
    """Trim each implausible word in place onto ``audio``; returns how many changed."""
    trimmed = 0
    for word in words:
        if not caps.is_implausible(word):
            continue
        runs = voiced_runs(audio, word.start, word.end, floor_db=caps.floor_db)
        start, end = plausible_span(word.start, word.end, caps.cap_for(word), runs)
        if word.trimmed_from is None:
            word.trimmed_from = (word.start, word.end)
        word.start, word.end = start, end
        trimmed += 1
    return trimmed


def trim_project_word_spans(project: EpisodeProject, defaults: dict[str, Any]) -> dict[str, int]:
    """Trim implausible words on every dialogue transcript; ``{job label: words trimmed}``.

    Decodes a recording only when its transcript holds an implausible word. A recording
    that cannot be decoded keeps its spans (they stay flagged as anomalous durations).
    """
    caps = WordSpanCaps.from_defaults(defaults)
    stored = {t.key: t for t in project.transcripts}
    counts: dict[str, int] = {}
    for job in dialogue_transcribe_jobs(project):
        transcript = stored.get(job.key)
        if transcript is None or not any(caps.is_implausible(w) for w in transcript.words):
            continue
        try:
            audio = TrackRmsCache.from_timeline_stem(job.audio, sample_rate=WAVEFORM_SAMPLE_RATE)
        except Exception as exc:
            log.warning("word-span trim skipped for %s: %s", job.label, exc)
            continue
        counts[job.label] = trim_implausible_words(transcript.words, audio, caps)
    return counts
