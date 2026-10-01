from __future__ import annotations

from typing import Any
from uuid import uuid4

from podcast_mcp.edits.comments import comments_for_view
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync import list_delta

COMMENTS_SANITY_S = 30.0


def review_comments_locked(ws: ProjectWorkspace) -> list[dict[str, Any]]:
    with ws.transaction(force_reload_if=lambda: True):
        return comments_for_view(ws.project)


class ReviewCommentsReplica:
    def __init__(self) -> None:
        self._comments: list[dict[str, Any]] | None = None
        self._revision: str | None = None

    def update(self, comments: list[dict[str, Any]]) -> dict[str, Any] | None:
        if comments == self._comments:
            return None
        revision = uuid4().hex
        frame: dict[str, Any]
        if self._comments is None:
            frame = {
                "plane": "comments",
                "type": "Snapshot",
                "revision": revision,
                "comments": comments,
            }
        else:
            frame = {
                "plane": "comments",
                "type": "Applied",
                "revision": revision,
                "previous_revision": self._revision,
                "operations": list_delta("comments", self._comments, comments),
            }
        self._comments = comments
        self._revision = revision
        return frame
