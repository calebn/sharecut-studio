from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from podcast_mcp.edits.transcript_cuts import ensure_combined_transcript
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.timebase import SourceSec


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
    for u in combined.utterances:
        spans = st.map_source_span(u.track_id, SourceSec(u.start), SourceSec(u.end))
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


def utterances_to_srt(project: EpisodeProject) -> str:
    blocks: list[str] = []
    for i, u in enumerate(_timeline_utterances(project), 1):
        blocks.append(f"{i}\n{_format_srt_time(u.start)} --> {_format_srt_time(u.end)}\n{u.text}\n")
    return "\n".join(blocks)


def utterances_to_vtt(project: EpisodeProject) -> str:
    lines = ["WEBVTT", ""]
    for u in _timeline_utterances(project):
        lines.append(
            f"{_format_srt_time(u.start).replace(',', '.')} --> "
            f"{_format_srt_time(u.end).replace(',', '.')}\n{u.text}\n"
        )
    return "\n".join(lines)
