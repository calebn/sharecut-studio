from __future__ import annotations

from podcast_mcp.edits.chapters import (
    add_chapter,
    delete_chapter,
    list_chapters,
    remove_chapter,
    update_chapter,
)
from podcast_mcp.models import ChapterMarker
from podcast_mcp.services.document.chapter_results import DeletedChapter, RemovedChapter
from podcast_mcp.services.document.service_base import WorkspaceService


class _ChapterOps(WorkspaceService):
    def add_chapter(self, at_time: float, title: str) -> ChapterMarker:
        def mutate(p) -> ChapterMarker:
            return add_chapter(p, at_time, title)

        return self.ws.mutate("before add chapter", "after add chapter", mutate)

    def remove_chapter(self, title: str) -> RemovedChapter:
        def mutate(p) -> RemovedChapter:
            ok = remove_chapter(p, title)
            return RemovedChapter(removed=ok, title=title)

        return self.ws.mutate("before remove chapter", "after remove chapter", mutate)

    def update_chapter(
        self,
        old_time: float,
        old_title: str,
        *,
        time: float,
        title: str,
    ) -> ChapterMarker:
        def mutate(p) -> ChapterMarker:
            return update_chapter(p, old_time, old_title, time=time, title=title)

        return self.ws.mutate("before update chapter", "after update chapter", mutate)

    def delete_chapter(self, time: float, title: str) -> DeletedChapter:
        def mutate(p) -> DeletedChapter:
            ok = delete_chapter(p, time, title)
            return DeletedChapter(deleted=ok, time=time, title=title)

        return self.ws.mutate("before delete chapter", "after delete chapter", mutate)

    def list_chapters(self) -> list[dict]:
        return [c.model_dump() for c in list_chapters(self.ws.project)]
