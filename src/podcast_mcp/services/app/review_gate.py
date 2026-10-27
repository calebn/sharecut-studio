"""One service over a review gate: status, brief, mark done, waive."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from podcast_mcp.edits.review_gate import ReviewGate, ReviewSource, check_gate_text_length
from podcast_mcp.services.app.workspace import ProjectWorkspace


class ReviewGateService:
    """``transactional`` stamps inside the workspace transaction and saves the project."""

    def __init__(
        self, workspace: ProjectWorkspace, gate: ReviewGate, *, transactional: bool = False
    ) -> None:
        self.ws = workspace
        self.gate = gate
        self.transactional = transactional

    def status(self) -> dict[str, Any]:
        self.ws.reload()
        return self.gate.report(self.ws.project, self.ws.effective_config())

    def brief(self) -> dict[str, Any]:
        self.ws.reload()
        return self.gate.brief(self.ws.project, self.ws.effective_config())

    def mark_done(
        self, *, notes: str | None = None, source: ReviewSource = "cli"
    ) -> dict[str, Any]:
        self.check_notes(notes)
        return self._stamp(lambda: self.gate.mark_done(self.ws.project, source=source, notes=notes))

    def waive(self, *, reason: str, source: ReviewSource = "cli") -> dict[str, Any]:
        check_gate_text_length(reason, subject="The reason is")
        return self._stamp(
            lambda: self.gate.mark_waived(self.ws.project, reason=reason, source=source)
        )

    @staticmethod
    def check_notes(notes: str | None) -> None:
        check_gate_text_length(notes, subject="The notes are")

    def _stamp(self, write: Callable[[], dict[str, Any]]) -> dict[str, Any]:
        if not self.transactional:
            self.ws.reload()
            return write()
        with self.ws.transaction():
            payload = write()
            self.ws.save()
            return payload
