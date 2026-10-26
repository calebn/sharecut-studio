"""SessionSuggestionService - record sessions staged for an insert or replace target."""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.session_suggestions import (
    find_session_suggestion,
    list_session_suggestions,
    skip_session_suggestion,
)
from podcast_mcp.services.app import ProjectWorkspace


class SessionSuggestionService:
    def __init__(self, ws: ProjectWorkspace) -> None:
        self.ws = ws

    def list(self, *, status: str | None = None) -> list[dict[str, Any]]:
        """Staged sessions, optionally only those with ``status``."""
        return [
            row.model_dump(mode="json")
            for row in list_session_suggestions(self.ws.project, status=status)
        ]

    def skip(self, suggestion_id: str) -> dict[str, Any]:
        """Mark a pending staged session skipped (one undo step); its sources stay registered."""
        number = find_session_suggestion(self.ws.project, suggestion_id).session_number
        title = f"Skipped Session {number}"
        return self.ws.mutate(
            f"before {title}",
            f"after {title}",
            lambda p: skip_session_suggestion(p, suggestion_id).model_dump(mode="json"),
            operation="skip_session_suggestion",
            params={"suggestion_id": suggestion_id, "session_number": number},
        )
