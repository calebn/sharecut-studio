"""Show notes as the HTML podcast apps accept: p, ol, ul, li, a, b and i."""

from __future__ import annotations

import html
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass

from podcast_mcp.feed.model import Credit, FeedChapter, FeedView, Measured, Transcript
from podcast_mcp.feed.urls import hosted_url, stem_of

INTRO_KEY = "item.intro"
NOTES_KEY = "item.notes"
MEDIA_URL_KEY = "channel.mediaUrl"
_TRANSCRIPT_ORDER = ("VTT", "SRT")


def clock(seconds: float) -> str:
    """``M:SS``, or ``H:MM:SS`` from an hour on, for a chapter start."""
    total = math.floor(max(0.0, seconds) * 10 + 0.5) // 10
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02}:{secs:02}" if hours else f"{minutes}:{secs:02}"


def _text(value: str) -> str:
    return html.escape(value, quote=False)


def transcript_href(
    template: str | None, audio_file: str | None, transcripts: Sequence[Transcript]
) -> str | None:
    """The hosted transcript a reader should open first (VTT over SRT), if it can be addressed."""
    if template is None or audio_file is None:
        return None
    formats = {t.format for t in transcripts}
    for name in _TRANSCRIPT_ORDER:
        if name in formats:
            return hosted_url(template, f"{stem_of(audio_file)}.{name.lower()}")
    return None


@dataclass(frozen=True)
class NotesParts:
    intro: str | None
    chapters: Sequence[FeedChapter]
    credits: Sequence[Credit]
    transcript_href: str | None


def compose_notes(parts: NotesParts) -> str:
    """The intro with live chapters, credits and a transcript link. Nothing here is stored."""
    blocks: list[str] = []
    if parts.intro:
        blocks.append(f"<p>{_text(parts.intro)}</p>")
    if parts.chapters:
        items = "".join(f"<li>{clock(c.at)} {_text(c.title)}</li>" for c in parts.chapters)
        blocks.append(f"<p>Chapters</p><ol>{items}</ol>")
    if parts.credits:
        items = "".join(f"<li>{_text(c.name)}, {_text(c.role)}</li>" for c in parts.credits)
        blocks.append(f"<p>With</p><ul>{items}</ul>")
    if parts.transcript_href:
        href = html.escape(parts.transcript_href, quote=True)
        blocks.append(f'<p><a href="{href}">Transcript</a></p>')
    return "".join(blocks)


def pinned_notes_html(text: str) -> str:
    return "".join(
        "<p>" + _text(paragraph).replace("\n", "<br>") + "</p>"
        for paragraph in re.split(r"\n{2,}", text.strip("\n"))
    )


def notes_html(view: FeedView) -> str:
    """The notes a view carries: the pinned text, or the composition of its own facts."""
    pinned = view.item.get(NOTES_KEY)
    if pinned is not None and isinstance(pinned.value, str):
        return pinned_notes_html(pinned.value)
    intro = view.item.get(INTRO_KEY)
    audio = view.sections.audio.source
    template = view.channel.get(MEDIA_URL_KEY)
    return compose_notes(
        NotesParts(
            intro=intro.value if intro is not None and isinstance(intro.value, str) else None,
            chapters=view.sections.chapters.value or (),
            credits=view.sections.credits.value or (),
            transcript_href=transcript_href(
                template.value
                if template is not None and isinstance(template.value, str)
                else None,
                audio.file if isinstance(audio, Measured) else None,
                view.sections.transcripts.value or (),
            ),
        )
    )
