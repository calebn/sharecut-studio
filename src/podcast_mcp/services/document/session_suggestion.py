"""SessionSuggestionService - record sessions staged for an insert or replace target."""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.audio_check_override import audio_check_override
from podcast_mcp.edits.cut_speech import APPLY_ANYWAY
from podcast_mcp.edits.session_suggestions import (
    accept_session_suggestion,
    find_session_suggestion,
    list_session_suggestions,
    skip_session_suggestion,
)
from podcast_mcp.edits.transcript_refine_status import (
    REFINE_GATE,
    TranscriptRefineRequiredError,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.service_base import mutate_unless_cut_speech_held

REPLACE_REFINE_HINT = (
    "The transcript clean-up needs to finish first, so the words this replace removes are "
    "the right ones. Finish it with `podcast transcript refine-done` / "
    "`transcript_refine_done_tool`, or skip it with `podcast transcript refine-waive "
    "--reason ...` / `transcript_refine_waive_tool`, then accept again."
)


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

    def accept(
        self,
        suggestion_id: str,
        take_index: int | None = None,
        override_audio_checks: bool = False,
    ) -> dict[str, Any]:
        """Place a pending staged session on the timeline (one undo step titled "Added Session N").

        An insert opens the session's span at its insert point on every dialogue track and
        places the staged takes, room-tone beds and live comments in it. A replace removes its
        range on every dialogue track and puts one take (``take_index``, else the selected or
        last one) in its place. A replace that also removes speech of a track the take did not
        record changes nothing and returns ``needs_confirmation``; repeat with
        ``override_audio_checks=true`` to apply it. Marks the suggestion accepted.
        """
        row = find_session_suggestion(self.ws.project, suggestion_id)
        if row.kind == "replace":
            try:
                REFINE_GATE.assert_clear(self.ws.project, defaults=self.ws.effective_config())
            except TranscriptRefineRequiredError as gated:
                raise TranscriptRefineRequiredError(REPLACE_REFINE_HINT) from gated
        title = f"Added Session {row.session_number}"
        return mutate_unless_cut_speech_held(
            self.ws,
            title,
            "accept_session_suggestion",
            lambda p: accept_session_suggestion(
                p,
                suggestion_id,
                take_index=take_index,
                override_audio_checks=override_audio_checks,
                defaults=self.ws.effective_config(),
            ),
            {
                "suggestion_id": suggestion_id,
                "session_id": row.session_id,
                "session_number": row.session_number,
            },
        )

    def accept_naming_override(
        self,
        suggestion_id: str,
        *,
        take_index: int | None = None,
        override_audio_checks: bool = False,
    ) -> dict[str, Any]:
        """``accept`` for a caller that has no flag help of its own (an agent tool), under the MCP host's override surface.

        A held replace's message also names how to apply it, so the person is not left
        guessing the parameter. The CLI and HTTP surfaces use ``accept`` and add their own.
        """
        with audio_check_override("mcp:host", "host_mcp", enabled=override_audio_checks):
            result = self.accept(
                suggestion_id, take_index=take_index, override_audio_checks=override_audio_checks
            )
        held = result.get("needs_confirmation")
        if isinstance(held, dict) and isinstance(held.get("message"), str):
            held["message"] = f"{held['message']} {APPLY_ANYWAY}"
        return result
