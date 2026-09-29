from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
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

_SENTENCE_END_PUNCT = (".", "!", "?", "…")
_PHRASE_END_PUNCT = (",", ";", ":")


@dataclass(frozen=True)
class CaptionLimits:
    """Cue-splitting limits for SRT/VTT export (defaults follow common caption guidance)."""

    max_duration_sec: float = DEFAULT_CAPTION_MAX_DURATION_SEC
    max_chars_per_line: int = DEFAULT_CAPTION_MAX_CHARS_PER_LINE
    max_lines: int = DEFAULT_CAPTION_MAX_LINES


def resolve_caption_limits(export_cfg: Mapping[str, Any]) -> CaptionLimits:
    """Caption limits from pipeline export config's ``captions`` block, else defaults."""
    raw = export_cfg.get("captions") or {}
    return CaptionLimits(
        max_duration_sec=float(raw.get("max_duration_sec", DEFAULT_CAPTION_MAX_DURATION_SEC)),
        max_chars_per_line=int(raw.get("max_chars_per_line", DEFAULT_CAPTION_MAX_CHARS_PER_LINE)),
        max_lines=int(raw.get("max_lines", DEFAULT_CAPTION_MAX_LINES)),
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


def _timeline_word_runs(project: EpisodeProject) -> list[list[_CueWord]]:
    """Per-utterance-run lists of timeline-mapped words, sorted, fully-cut words dropped.

    Same clock mapping and drop-if-cut policy as ``_timeline_utterances``, but keeps
    per-word timing (from ``transcript_word_runs``, the shared kept-word grouping
    behind ``merge_transcripts``) so a cue can be split inside a run instead of only
    inside a whole utterance.
    """
    st = SessionTimeline(project)
    out: list[tuple[float, list[_CueWord]]] = []
    for run in transcript_word_runs(project):
        mapped = st.map_word_spans(run.track_id, [(w.start, w.end) for w in run.words])
        words = [
            _CueWord(text=w.text, start=float(spans[0][0]), end=float(spans[-1][1]))
            for w, spans in zip(run.words, mapped, strict=True)
            if spans
        ]
        if words:
            out.append((words[0].start, words))
    out.sort(key=lambda item: item[0])
    return [words for _, words in out]


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


def _split_run_into_cues(words: list[_CueWord], limits: CaptionLimits) -> list[_Cue]:
    """Greedily fill each cue to the limits.

    A break at sentence/phrase punctuation (the latest one found before the limits
    force a stop) is used only when the rest of the run does not fit in one cue.
    When everything remaining fits, it stays one cue even if it contains internal
    punctuation: `` "Yeah, totally." `` is one cue, not two.
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
            if j < total:
                last_text = candidate[-1].text
                if last_text.endswith(_SENTENCE_END_PUNCT):
                    sentence_break = j
                elif last_text.endswith(_PHRASE_END_PUNCT):
                    phrase_break = j
            j += 1
        end = (sentence_break or phrase_break or last_good) if truncated else last_good
        chunk = words[i:end]
        lines = _wrap_cue_lines([w.text for w in chunk], limits) or [
            " ".join(w.text for w in chunk)
        ]
        cues.append(_Cue(text="\n".join(lines), start=chunk[0].start, end=chunk[-1].end))
        i = end
    return cues


def _timeline_cues(project: EpisodeProject, limits: CaptionLimits) -> list[_Cue]:
    """All cues, ordered by start (stable): a run's cues can interleave with another
    track's run that starts partway through it."""
    cues: list[_Cue] = []
    for words in _timeline_word_runs(project):
        cues.extend(_split_run_into_cues(words, limits))
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
