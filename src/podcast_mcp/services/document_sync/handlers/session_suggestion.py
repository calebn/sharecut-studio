"""Document-plane handlers for staged record sessions (insert and replace suggestions)."""

from __future__ import annotations

from typing import Any

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import SessionSuggestionService


def accept_session_suggestion(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    """Place the session; a replace that would cut other speech returns ``needs_confirmation``."""
    take = p.get("take_index")
    return SessionSuggestionService(ws).accept(
        str(p["suggestion_id"]),
        take_index=None if take is None else int(take),
        override_audio_checks=bool(p.get("override_audio_checks", False)),
    )


def skip_session_suggestion(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return SessionSuggestionService(ws).skip(str(p["suggestion_id"]))


def select_session_take(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return SessionSuggestionService(ws).select_take(str(p["suggestion_id"]), int(p["take_index"]))


HANDLERS = {
    "AcceptSessionSuggestion": accept_session_suggestion,
    "SkipSessionSuggestion": skip_session_suggestion,
    "SelectSessionTake": select_session_take,
}
