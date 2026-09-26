"""Transcript refine status service - agent gate after precorrect."""

from __future__ import annotations

from typing import Any

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.transcript_refine_status import (
    build_refine_brief,
    mark_refine_done,
    mark_refine_waived,
    refine_status_report,
)
from podcast_mcp.services.workspace import ProjectWorkspace


class TranscriptRefineService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace

    def _defaults(self) -> dict[str, Any]:
        return load_defaults()

    def _reload(self) -> None:
        self.ws.reload()

    def status(self) -> dict[str, Any]:
        self._reload()
        return refine_status_report(self.ws.project, defaults=self._defaults())

    def brief(self) -> dict[str, Any]:
        self._reload()
        return build_refine_brief(self.ws.project, defaults=self._defaults())

    def mark_done(self, *, notes: str | None = None, source: str = "cli") -> dict[str, Any]:
        with self.ws.transaction():
            payload = mark_refine_done(
                self.ws.project,
                source=source,  # type: ignore[arg-type]
                notes=notes,
            )
            self.ws.save()
            return payload

    def waive(self, *, reason: str, source: str = "cli") -> dict[str, Any]:
        with self.ws.transaction():
            payload = mark_refine_waived(
                self.ws.project,
                reason=reason,
                source=source,  # type: ignore[arg-type]
            )
            self.ws.save()
            return payload
