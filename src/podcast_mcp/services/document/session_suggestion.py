"""SessionSuggestionService - record sessions staged for an insert or replace target."""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.session_suggestions import (
    accept_session_suggestion,
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

    def accept(self, suggestion_id: str) -> dict[str, Any]:
        """Place a pending insert session on the timeline (one undo step titled "Added Session N").

        Opens the session's span at its insert point on every dialogue track, places the
        staged takes, room-tone beds and live comments in it, and marks the suggestion accepted.
        """
        row = find_session_suggestion(self.ws.project, suggestion_id)
        title = f"Added Session {row.session_number}"
        return self.ws.mutate(
            f"before {title}",
            f"after {title}",
            lambda p: accept_session_suggestion(
                p, suggestion_id, defaults=self.ws.effective_config()
            ),
            operation="accept_session_suggestion",
            params={
                "suggestion_id": suggestion_id,
                "session_id": row.session_id,
                "session_number": row.session_number,
            },
        )
