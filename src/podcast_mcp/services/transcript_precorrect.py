from __future__ import annotations

from typing import Any

from podcast_mcp.edits.transcript_precorrect import run_precorrect_transcript
from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.transcript_context import (
    TranscriptContext,
    context_to_dict,
    load_transcript_context,
)
from podcast_mcp.util.progress import ProgressReporter, resolve_progress


class TranscriptPrecorrectService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace

    def load_context(self) -> TranscriptContext:
        return load_transcript_context(self.ws.project.workspace_path())

    def get_context(self) -> dict[str, Any]:
        return context_to_dict(self.load_context())

    def set_context(self, ctx: TranscriptContext) -> str:
        path = ctx.save(self.ws.project.workspace_path())
        return str(path)

    def precorrect(
        self,
        *,
        dry_run: bool = True,
        progress: ProgressReporter | None = None,
        defaults: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        ctx = self.load_context()
        policy = AnalysisPolicy.from_defaults(defaults)

        def mutate(p):
            result = run_precorrect_transcript(
                p,
                dry_run=False,
                policy=policy,
                progress=resolve_progress(progress),
                context=ctx,
            )
            return result.to_dict()

        if dry_run:
            result = run_precorrect_transcript(
                self.ws.project,
                dry_run=True,
                policy=policy,
                progress=resolve_progress(progress),
                context=ctx,
            )
            return result.to_dict()

        return self.ws.mutate(
            "before transcript precorrect",
            "after transcript precorrect",
            mutate,
        )
