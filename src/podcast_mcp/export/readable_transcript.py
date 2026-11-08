from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

from podcast_mcp.models import EpisodeProject

_END = re.compile(r"[.!?…][\"'\u201d\u2019\)\]\}]*$")


@dataclass(frozen=True)
class ReadableEntry:
    speaker: str
    start: float
    text: str


@dataclass(frozen=True)
class ReadableTurn:
    speaker: str
    start: float
    entries: tuple[str, ...]

    @property
    def paragraphs(self) -> tuple[str, ...]:
        return _paragraphs(self.entries)


def readable_turns(entries: Iterable[ReadableEntry]) -> tuple[ReadableTurn, ...]:
    turns: list[ReadableTurn] = []
    for entry in sorted(entries, key=lambda item: item.start):
        text = re.sub(r"[ \t]+", " ", entry.text).strip()
        if not text:
            continue
        if turns and turns[-1].speaker == entry.speaker:
            previous = turns[-1]
            turns[-1] = ReadableTurn(
                previous.speaker,
                previous.start,
                (*previous.entries, text),
            )
        else:
            turns.append(ReadableTurn(entry.speaker, entry.start, (text,)))
    return tuple(turns)


def _paragraphs(fragments: tuple[str, ...]) -> tuple[str, ...]:
    paragraphs: list[str] = []
    current: list[str] = []

    def append_text(text: str) -> None:
        for word in text.split():
            current.append(word)
            if len(current) >= 80 and _END.search(word):
                paragraphs.append(" ".join(current))
                current.clear()

    for fragment in fragments:
        parts = re.split(r"\n[ \t]*\n+", fragment)
        for index, part in enumerate(parts):
            append_text(part)
            if index < len(parts) - 1 and current:
                paragraphs.append(" ".join(current))
                current.clear()
        if len(fragments) > 1 and len(current) >= 160:
            paragraphs.append(" ".join(current))
            current.clear()
    if current:
        paragraphs.append(" ".join(current))
    return tuple(paragraphs)


def render_readable_transcript(project: EpisodeProject, entries: Iterable[ReadableEntry]) -> str:
    turns = readable_turns(entries)
    if not turns:
        return ""
    lines = [project.name, ""]
    for turn in turns:
        lines.append(f"{turn.speaker}  {_clock(turn.start)}")
        lines.append("\n\n".join(turn.paragraphs))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _clock(seconds: float) -> str:
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes}:{seconds:02d}"
