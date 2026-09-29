from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from podcast_mcp.edits.transcript_cuts import ensure_combined_transcript
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.engines.utterance_runs import transcript_word_runs
from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.timebase import SourceSec

# Common caption guidance: at most ~2 lines of ~42 characters, at most ~7s on screen.
DEFAULT_CAPTION_MAX_DURATION_SEC = 7.0
DEFAULT_CAPTION_MAX_CHARS_PER_LINE = 42
DEFAULT_CAPTION_MAX_LINES = 2
# Minimum on-screen time (#790): a cue under this is merged into a same-track neighbour
# (see DEFAULT_CAPTION_MERGE_MAX_GAP_SEC), else held to this duration.
DEFAULT_CAPTION_MIN_DURATION_SEC = 1.0
# Largest gap to a same-track neighbour a sub-minimum cue may still merge across.
DEFAULT_CAPTION_MERGE_MAX_GAP_SEC = 1.5

_SENTENCE_END_PUNCT = (".", "!", "?", "…")
_PHRASE_END_PUNCT = (",", ";", ":")


@dataclass(frozen=True)
class CaptionLimits:
    """Cue-splitting limits for SRT/VTT export (defaults follow common caption guidance)."""

    max_duration_sec: float = DEFAULT_CAPTION_MAX_DURATION_SEC
    max_chars_per_line: int = DEFAULT_CAPTION_MAX_CHARS_PER_LINE
    max_lines: int = DEFAULT_CAPTION_MAX_LINES
    min_duration_sec: float = DEFAULT_CAPTION_MIN_DURATION_SEC
    merge_max_gap_sec: float = DEFAULT_CAPTION_MERGE_MAX_GAP_SEC

    def __post_init__(self) -> None:
        if self.max_lines < 1:
            raise ValueError(f"export.captions.max_lines must be >= 1, got {self.max_lines}")
        if self.max_duration_sec <= 0:
            raise ValueError(
                f"export.captions.max_duration_sec must be > 0, got {self.max_duration_sec}"
            )


def resolve_caption_limits(export_cfg: Mapping[str, Any]) -> CaptionLimits:
    """Caption limits from pipeline export config's ``captions`` block, else defaults.

    Raises ``ValueError`` (a domain error, not a CLI usage error: this reads config, not
    flags) when a configured limit fails ``CaptionLimits``'s own invariants.
    """
    raw = export_cfg.get("captions") or {}
    return CaptionLimits(
        max_duration_sec=float(raw.get("max_duration_sec", DEFAULT_CAPTION_MAX_DURATION_SEC)),
        max_chars_per_line=int(raw.get("max_chars_per_line", DEFAULT_CAPTION_MAX_CHARS_PER_LINE)),
        max_lines=int(raw.get("max_lines", DEFAULT_CAPTION_MAX_LINES)),
        min_duration_sec=float(raw.get("min_duration_sec", DEFAULT_CAPTION_MIN_DURATION_SEC)),
        merge_max_gap_sec=float(raw.get("merge_max_gap_sec", DEFAULT_CAPTION_MERGE_MAX_GAP_SEC)),
    )


@dataclass(frozen=True)
class _TimelineUtterance:
    """A combined utterance projected onto the session/deliverable clock."""

    speaker: str
    text: str
    start: float
    end: float


def _timeline_utterances(project: EpisodeProject) -> list[_TimelineUtterance]:
    """Combined utterances mapped from source to timeline, sorted, gaps dropped.

    Exports ship alongside the mastered (timeline-clock) audio, but utterance
    times are stored in source coordinates. Each is projected through
    ``SessionTimeline``; utterances entirely inside removed material are omitted.
    """
    combined = ensure_combined_transcript(project)
    st = SessionTimeline(project)
    out: list[_TimelineUtterance] = []
    by_track: dict[str, list[tuple[SourceSec, SourceSec]]] = {}
    for u in combined.utterances:
        by_track.setdefault(u.track_id, []).append((SourceSec(u.start), SourceSec(u.end)))
    mapped = {
        track_id: iter(st.map_source_spans(track_id, spans)) for track_id, spans in by_track.items()
    }
    for u in combined.utterances:
        spans = next(mapped[u.track_id])
        if not spans:
            continue
        out.append(
            _TimelineUtterance(
                speaker=u.speaker,
                text=u.text,
                start=float(spans[0][0]),
                end=float(spans[-1][1]),
            )
        )
    out.sort(key=lambda u: u.start)
    return out


def combined_transcript_markdown(project: EpisodeProject) -> str:
    lines = [f"# {project.name}\n"]
    for u in _timeline_utterances(project):
        lines.append(f"**{u.speaker}** [{u.start:.1f}s]: {u.text}\n")
    return "\n".join(lines)


def write_combined_transcript_markdown(project: EpisodeProject) -> Path:
    project.export_dir().mkdir(parents=True, exist_ok=True)
    out = project.export_dir() / f"{sanitize_export_stem(project.name)}.md"
    out.write_text(combined_transcript_markdown(project), encoding="utf-8")
    return out


def _format_srt_time(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int((sec % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


@dataclass(frozen=True)
class _CueWord:
    """One caption word, mapped onto the session/deliverable clock."""

    text: str
    start: float
    end: float


@dataclass(frozen=True)
class _Cue:
    text: str
    start: float
    end: float
    track_id: str
    words: tuple[_CueWord, ...]


def _timeline_word_runs(project: EpisodeProject) -> list[tuple[str, list[_CueWord]]]:
    """Per-utterance-run ``(track_id, words)`` pairs, sorted, fully-cut words dropped.

    Same clock mapping and drop-if-cut policy as ``_timeline_utterances``, but keeps
    per-word timing (from ``transcript_word_runs``, the shared kept-word grouping
    behind ``merge_transcripts``) so a cue can be split inside a run instead of only
    inside a whole utterance.
    """
    st = SessionTimeline(project)
    out: list[tuple[float, str, list[_CueWord]]] = []
    for run in transcript_word_runs(project):
        mapped = st.map_word_spans(run.track_id, [(w.start, w.end) for w in run.words])
        words = [
            _CueWord(text=w.text, start=float(spans[0][0]), end=float(spans[-1][1]))
            for w, spans in zip(run.words, mapped, strict=True)
            if spans
        ]
        if words:
            out.append((words[0].start, run.track_id, words))
    out.sort(key=lambda item: item[0])
    return [(track_id, words) for _, track_id, words in out]


def _wrap_cue_lines(texts: list[str], limits: CaptionLimits) -> list[str] | None:
    """Greedy word-wrap; ``None`` if it needs more than ``max_lines`` or overflows a line.

    Never splits inside a word: a single word longer than ``max_chars_per_line``
    still gets its own (overlong) line, which is what makes the result invalid here.
    """
    lines: list[str] = []
    current = ""
    for text in texts:
        candidate = f"{current} {text}".strip()
        if current and len(candidate) > limits.max_chars_per_line:
            lines.append(current)
            current = text
        else:
            current = candidate
    if current:
        lines.append(current)
    if len(lines) > limits.max_lines or any(
        len(line) > limits.max_chars_per_line for line in lines
    ):
        return None
    return lines


def _cue_fits(candidate: list[_CueWord], limits: CaptionLimits) -> bool:
    """Whether ``candidate`` can be one cue. A lone word always fits (never split inside it)."""
    if len(candidate) == 1:
        return True
    if candidate[-1].end - candidate[0].start > limits.max_duration_sec:
        return False
    return _wrap_cue_lines([w.text for w in candidate], limits) is not None


def _render_cue(words: list[_CueWord], limits: CaptionLimits, track_id: str) -> _Cue:
    """Build a ``_Cue`` from a word chunk already known to fit (or the hard fallback)."""
    lines = _wrap_cue_lines([w.text for w in words], limits) or [" ".join(w.text for w in words)]
    return _Cue(
        text="\n".join(lines),
        start=words[0].start,
        end=words[-1].end,
        track_id=track_id,
        words=tuple(words),
    )


def _split_run_into_cues(
    words: list[_CueWord], limits: CaptionLimits, track_id: str = ""
) -> list[_Cue]:
    """Greedily fill each cue to the limits.

    A break at sentence/phrase punctuation (the latest one found before the limits
    force a stop) is used only when the rest of the run does not fit in one cue, and
    only when it leaves at least two words before the break: a break candidate of a
    single word (e.g. "Anyway," alone) is skipped so a phrase break never strands a
    one-word lead cue (#790). When everything remaining fits, it stays one cue even if
    it contains internal punctuation: `` "Yeah, totally." `` is one cue, not two.
    """
    cues: list[_Cue] = []
    i, total = 0, len(words)
    while i < total:
        last_good = i + 1
        sentence_break: int | None = None
        phrase_break: int | None = None
        j = i + 1
        truncated = False
        while j <= total:
            candidate = words[i:j]
            if not _cue_fits(candidate, limits):
                truncated = True
                break
            last_good = j
            if j < total and j - i >= 2:
                last_text = candidate[-1].text
                if last_text.endswith(_SENTENCE_END_PUNCT):
                    sentence_break = j
                elif last_text.endswith(_PHRASE_END_PUNCT):
                    phrase_break = j
            j += 1
        end = (sentence_break or phrase_break or last_good) if truncated else last_good
        cues.append(_render_cue(words[i:end], limits, track_id))
        i = end
    return cues


def _by_track(cues: list[_Cue]) -> list[list[_Cue]]:
    """Group cues by track, keeping each group's relative (start-sorted) order."""
    groups: dict[str, list[_Cue]] = {}
    for cue in cues:
        groups.setdefault(cue.track_id, []).append(cue)
    return list(groups.values())


def _merge_short_cues(track_cues: list[_Cue], limits: CaptionLimits) -> list[_Cue]:
    """Merge a cue under ``min_duration_sec`` into its nearest same-track neighbour
    (smaller gap first) when the gap is at most ``merge_max_gap_sec`` and the merged
    cue still fits the limits. Repeats until no more merges apply."""
    cues = list(track_cues)
    changed = True
    while changed:
        changed = False
        for i, cue in enumerate(cues):
            if cue.end - cue.start >= limits.min_duration_sec:
                continue
            neighbours: list[tuple[float, int, int]] = []
            if i > 0:
                neighbours.append((cue.start - cues[i - 1].end, i - 1, i))
            if i + 1 < len(cues):
                neighbours.append((cues[i + 1].start - cue.end, i, i + 1))
            for gap, lo, hi in sorted(neighbours, key=lambda n: n[0]):
                if gap > limits.merge_max_gap_sec:
                    continue
                merged_words = list(cues[lo].words) + list(cues[hi].words)
                if not _cue_fits(merged_words, limits):
                    continue
                cues[lo : hi + 1] = [_render_cue(merged_words, limits, cue.track_id)]
                changed = True
                break
            if changed:
                break
    return cues


def _extend_short_cues(track_cues: list[_Cue], limits: CaptionLimits) -> list[_Cue]:
    """Hold any cue still under ``min_duration_sec`` to that duration, never past the
    start of the next cue on the same track."""
    cues = list(track_cues)
    for i, cue in enumerate(cues):
        if cue.end - cue.start >= limits.min_duration_sec:
            continue
        cap = cues[i + 1].start if i + 1 < len(cues) else float("inf")
        new_end = min(cue.start + limits.min_duration_sec, cap)
        if new_end > cue.end:
            cues[i] = replace(cue, end=new_end)
    return cues


def _apply_min_duration(cues: list[_Cue], limits: CaptionLimits) -> list[_Cue]:
    """Minimum on-screen time (#790): merge sub-minimum cues into a same-track
    neighbour where that still fits, then hold any cue still under the minimum."""
    merged = [cue for group in _by_track(cues) for cue in _merge_short_cues(group, limits)]
    return [cue for group in _by_track(merged) for cue in _extend_short_cues(group, limits)]


def _timeline_cues(project: EpisodeProject, limits: CaptionLimits) -> list[_Cue]:
    """All cues, ordered by start (stable): a run's cues can interleave with another
    track's run that starts partway through it."""
    cues: list[_Cue] = []
    for track_id, words in _timeline_word_runs(project):
        cues.extend(_split_run_into_cues(words, limits, track_id))
    cues = _apply_min_duration(cues, limits)
    cues.sort(key=lambda cue: cue.start)
    return cues


def utterances_to_srt(project: EpisodeProject, limits: CaptionLimits | None = None) -> str:
    limits = limits or CaptionLimits()
    blocks: list[str] = []
    for i, cue in enumerate(_timeline_cues(project, limits), 1):
        blocks.append(
            f"{i}\n{_format_srt_time(cue.start)} --> {_format_srt_time(cue.end)}\n{cue.text}\n"
        )
    return "\n".join(blocks)


def utterances_to_vtt(project: EpisodeProject, limits: CaptionLimits | None = None) -> str:
    limits = limits or CaptionLimits()
    lines = ["WEBVTT", ""]
    for cue in _timeline_cues(project, limits):
        lines.append(
            f"{_format_srt_time(cue.start).replace(',', '.')} --> "
            f"{_format_srt_time(cue.end).replace(',', '.')}\n{cue.text}\n"
        )
    return "\n".join(lines)
