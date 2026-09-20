from __future__ import annotations

from podcast_mcp.models import ChapterMarker, EpisodeProject


def add_chapter(project: EpisodeProject, at_time: float, title: str) -> ChapterMarker:
    """Add a chapter marker. ``at_time`` is TIMELINE seconds (the deliverable
    clock): chapters ship beside the mastered audio, so callers using a
    transcript search result must pass ``TranscriptMatch.timeline_start``."""
    ch = ChapterMarker(time=at_time, title=title)
    project.chapters.append(ch)
    project.chapters.sort(key=lambda c: c.time)
    return ch


def list_chapters(project: EpisodeProject) -> list[ChapterMarker]:
    return list(project.chapters)


def remove_chapter(project: EpisodeProject, title: str) -> bool:
    before = len(project.chapters)
    project.chapters = [c for c in project.chapters if c.title != title]
    return len(project.chapters) < before


def _find_chapter_index(project: EpisodeProject, time: float, title: str) -> int:
    for i, ch in enumerate(project.chapters):
        if ch.title == title and abs(ch.time - time) < 1e-6:
            return i
    raise ValueError(f"chapter not found: {title!r} at {time}")


def update_chapter(
    project: EpisodeProject,
    old_time: float,
    old_title: str,
    *,
    time: float,
    title: str,
) -> ChapterMarker:
    """Update a chapter matched by ``(old_time, old_title)``."""
    idx = _find_chapter_index(project, old_time, old_title)
    updated = ChapterMarker(time=float(time), title=str(title))
    project.chapters[idx] = updated
    project.chapters.sort(key=lambda c: c.time)
    return updated


def delete_chapter(project: EpisodeProject, time: float, title: str) -> bool:
    """Delete the chapter matched by ``(time, title)``."""
    idx = _find_chapter_index(project, time, title)
    project.chapters.pop(idx)
    return True
