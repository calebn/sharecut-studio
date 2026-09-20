"""Align accept status service — agent gate after conversation-clock align."""

from __future__ import annotations

from typing import Any

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.align_accept_status import (
    align_status_report,
    build_align_brief,
    mark_align_done,
    mark_align_waived,
)
from podcast_mcp.services.workspace import ProjectWorkspace


class AlignAcceptService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace

    def _defaults(self) -> dict[str, Any]:
        return load_defaults()

    def _reload(self) -> None:
        self.ws.reload()

    def status(self) -> dict[str, Any]:
        self._reload()
        return align_status_report(self.ws.project, defaults=self._defaults())

    def brief(self) -> dict[str, Any]:
        self._reload()
        return build_align_brief(self.ws.project, defaults=self._defaults())

    def mark_done(self, *, notes: str | None = None, source: str = "cli") -> dict[str, Any]:
        self._reload()
        payload = mark_align_done(
            self.ws.project,
            source=source,  # type: ignore[arg-type]
            notes=notes,
        )
        return payload

    def waive(self, *, reason: str, source: str = "cli") -> dict[str, Any]:
        self._reload()
        payload = mark_align_waived(
            self.ws.project,
            reason=reason,
            source=source,  # type: ignore[arg-type]
        )
        return payload
