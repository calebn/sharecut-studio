from __future__ import annotations

from copy import deepcopy
from typing import Any

from podcast_mcp.edits.transcript_precorrect import run_precorrect_transcript
from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.transcript_context import (
    TranscriptContext,
    context_from_dict,
    context_lock,
    context_to_dict,
    load_transcript_context,
    new_vocabulary_revision,
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
        workspace = self.ws.project.workspace_path()
        with context_lock(workspace):
            current = load_transcript_context(workspace)
            return self._save_context_locked(ctx, current)

    def _save_context_locked(self, ctx: TranscriptContext, current: TranscriptContext) -> str:
        if (ctx.terms, ctx.guest_names, ctx.initial_prompt_text()) != (
            current.terms,
            current.guest_names,
            current.initial_prompt_text(),
        ):
            _ensure_prompt_covers_vocabulary(ctx)
            ctx.vocabulary_revision = new_vocabulary_revision()
        else:
            ctx.vocabulary_revision = current.vocabulary_revision
        return str(ctx.save(self.ws.project.workspace_path()))

    def update_context(
        self,
        *,
        values: dict[str, Any] | None = None,
        terms: list[str] | None = None,
        guest_names: list[str] | None = None,
    ) -> str:
        workspace = self.ws.project.workspace_path()
        with context_lock(workspace):
            current = load_transcript_context(workspace)
            merged = {**context_to_dict(current), **(values or {})}
            if terms:
                merged["terms"] = [*current.terms, *terms]
            if guest_names:
                merged["guest_names"] = [*current.guest_names, *guest_names]
            next_ctx = context_from_dict(merged)
            return self._save_context_locked(next_ctx, current)

    def get_vocabulary(self) -> dict[str, Any]:
        ctx = self.load_context()
        return {
            "terms": ctx.terms,
            "guest_names": ctx.guest_names,
            "needs_retranscription": (
                ctx.vocabulary_revision
                != self.ws.project.transcript_data.vocabulary_revision_applied
            ),
        }

    def set_vocabulary(self, *, terms: list[str], guest_names: list[str]) -> dict[str, Any]:
        cleaned_terms = _clean_vocabulary(terms)
        cleaned_names = _clean_vocabulary(guest_names)
        workspace = self.ws.project.workspace_path()
        with context_lock(workspace):
            current = load_transcript_context(workspace)
            ctx = deepcopy(current)
            ctx.terms = cleaned_terms
            ctx.guest_names = cleaned_names
            if (ctx.terms, ctx.guest_names) != (current.terms, current.guest_names):
                self._save_context_locked(ctx, current)
        return self.get_vocabulary()

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


def _clean_vocabulary(values: list[str]) -> list[str]:
    cleaned = [value.strip() for value in values]
    if len(cleaned) > 100 or any(not value or len(value) > 100 for value in cleaned):
        raise ValueError("Vocabulary allows up to 100 non-empty entries of 100 characters each")
    return list(dict.fromkeys(cleaned))


def _ensure_prompt_covers_vocabulary(ctx: TranscriptContext) -> None:
    parts = [ctx.show_title or "", *ctx.terms, *ctx.guest_names]
    full_prompt = ", ".join(dict.fromkeys(part.strip() for part in parts if part.strip()))
    if full_prompt and ctx.initial_prompt_text() != full_prompt:
        raise ValueError(
            "Vocabulary exceeds the active Whisper prompt limit or prompting is disabled"
        )
