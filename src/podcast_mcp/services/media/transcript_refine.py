"""Transcript refine status service - agent gate after precorrect."""

from __future__ import annotations

from podcast_mcp.edits.transcript_refine_status import REFINE_GATE
from podcast_mcp.services.app import ProjectWorkspace, ReviewGateService


class TranscriptRefineService(ReviewGateService):
    def __init__(self, workspace: ProjectWorkspace) -> None:
        super().__init__(workspace, REFINE_GATE, transactional=True)
