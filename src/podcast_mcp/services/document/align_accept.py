"""Align accept status service - agent gate after conversation-clock align."""

from __future__ import annotations

from podcast_mcp.edits.align_accept_status import ALIGN_GATE
from podcast_mcp.services.app import ProjectWorkspace, ReviewGateService


class AlignAcceptService(ReviewGateService):
    def __init__(self, workspace: ProjectWorkspace) -> None:
        super().__init__(workspace, ALIGN_GATE)
