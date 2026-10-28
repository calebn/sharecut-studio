"""Transcript refine status service - agent gate after precorrect."""

from __future__ import annotations

from typing import Any

from podcast_mcp.config.defaults import load_defaults, unsure_word_confidence
from podcast_mcp.edits.review_gate import ReviewSource
from podcast_mcp.edits.transcript_correct import list_low_confidence
from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.services.app import ProjectWorkspace, ReviewGateService


class TranscriptRefineService(ReviewGateService):
    def __init__(self, workspace: ProjectWorkspace) -> None:
        super().__init__(workspace, REFINE_GATE, transactional=True)

    def gate_status(self) -> dict[str, Any]:
        """Gate report plus how many words sit below the unsure-word line."""
        report = self.status()
        line = unsure_word_confidence(self.ws.effective_config())
        return {
            **report,
            "low_confidence_words": len(list_low_confidence(self.ws.project, line)),
            "low_confidence_threshold": line,
        }

    def mark_checked(
        self, *, notes: str | None = None, source: ReviewSource = "user"
    ) -> dict[str, Any]:
        """Record refine-done once; a repeat while ``done`` still holds writes nothing.

        A waiver does not count: checking the transcript after "Cut anyway" is the
        stronger record, so it replaces the waiver. Returns :meth:`gate_status`.
        """
        self.check_notes(notes)
        with self.ws.transaction():
            current = self.gate.report(self.ws.project, load_defaults())
            if not (current["clear"] and current["stored_status"] == "done"):
                self.mark_done(notes=notes, source=source)
        return self.gate_status()
