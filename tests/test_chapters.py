from __future__ import annotations

from podcast_mcp.edits.chapters import (
    add_chapter,
    delete_chapter,
    list_chapters,
    remove_chapter,
    update_chapter,
)
from podcast_mcp.models import EpisodeProject


def test_chapter_add_list_remove():
    project = EpisodeProject.create("chapters", "/tmp/ws")
    ch1 = add_chapter(project, 30.0, "Intro")
    add_chapter(project, 10.0, "Cold open")
    assert ch1.title == "Intro"
    chapters = list_chapters(project)
    assert [c.title for c in chapters] == ["Cold open", "Intro"]
    assert remove_chapter(project, "Intro") is True
    assert remove_chapter(project, "missing") is False
    assert [c.title for c in list_chapters(project)] == ["Cold open"]


def test_chapter_update_and_delete_by_time_title():
    project = EpisodeProject.create("chapters2", "/tmp/ws2")
    add_chapter(project, 10.0, "A")
    add_chapter(project, 20.0, "B")
    updated = update_chapter(project, 10.0, "A", time=12.5, title="A'")
    assert updated.time == 12.5
    assert updated.title == "A'"
    assert [c.title for c in list_chapters(project)] == ["A'", "B"]
    assert delete_chapter(project, 12.5, "A'") is True
    assert [c.title for c in list_chapters(project)] == ["B"]
