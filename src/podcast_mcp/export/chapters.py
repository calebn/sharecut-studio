from __future__ import annotations

import json
from collections.abc import Sequence
from typing import NotRequired, TypedDict

from podcast_mcp.models import ChapterMarker

CHAPTERS_JSON_VERSION = "1.2.0"
START_TIME_DECIMALS = 3


class ChapterEntry(TypedDict):
    startTime: float
    title: str
    img: NotRequired[str]


class ChaptersDocument(TypedDict):
    """Podcasting 2.0 JSON chapters v1.2 (``application/json+chapters``)."""

    version: str
    chapters: list[ChapterEntry]


def _start_time(seconds: float) -> float:
    rounded = round(seconds, START_TIME_DECIMALS)
    return int(rounded) if rounded.is_integer() else rounded


def chapters_document(chapters: Sequence[ChapterMarker]) -> ChaptersDocument:
    """Marker times are timeline seconds, the clock the exported audio plays on."""
    entries: list[ChapterEntry] = []
    for marker in sorted(chapters, key=lambda c: c.time):
        entry: ChapterEntry = {"startTime": _start_time(marker.time), "title": marker.title}
        if marker.image_url:
            entry["img"] = marker.image_url
        entries.append(entry)
    return {"version": CHAPTERS_JSON_VERSION, "chapters": entries}


def render_chapters_json(chapters: Sequence[ChapterMarker]) -> str:
    return json.dumps(chapters_document(chapters), indent=2, ensure_ascii=False) + "\n"
