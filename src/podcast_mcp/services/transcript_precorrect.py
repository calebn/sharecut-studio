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

VOCABULARY_MAX_ENTRIES = 100
VOCABULARY_MAX_ENTRY_CHARS = 100


class VocabularyConflictError(RuntimeError):
    """Saved vocabulary changed after the caller read it (stale base_revision)."""


class TranscriptPrecorrectService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace

    def load_context(self) -> TranscriptContext:
        return load_transcript_context(self.ws.project.workspace_path())

    def get_context(self) -> dict[str, Any]:
        return context_to_dict(self.load_context())

    def set_context(self, ctx: TranscriptContext) -> str:
        """Replace transcript_context.yaml with ``ctx`` under the context lock.

        Raises ValueError when changed vocabulary would be truncated in the Whisper prompt,
        and filelock.Timeout when another writer holds the lock.
        """
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
        """Merge values into transcript_context.yaml under the context lock.

        Raises ValueError when changed vocabulary would be truncated in the Whisper prompt,
        or when changed terms or guest names break the entry limits, and filelock.Timeout
        when another writer holds the lock.
        """
        workspace = self.ws.project.workspace_path()
        with context_lock(workspace):
            current = load_transcript_context(workspace)
            merged = {**context_to_dict(current), **(values or {})}
            if terms:
                merged["terms"] = [*current.terms, *terms]
            if guest_names:
                merged["guest_names"] = [*current.guest_names, *guest_names]
            for key in ("terms", "guest_names"):
                if merged.get(key) != getattr(current, key):
                    merged[key] = _clean_vocabulary([str(v) for v in merged.get(key) or []])
            next_ctx = context_from_dict(merged)
            return self._save_context_locked(next_ctx, current)

    def get_vocabulary(self) -> dict[str, Any]:
        ctx = self.load_context()
        return {
            "terms": ctx.terms,
            "guest_names": ctx.guest_names,
            "revision": ctx.vocabulary_revision,
            # No transcripts means nothing to re-transcribe; otherwise any row
            # produced with another revision (or before revisions) is stale.
            "needs_retranscription": any(
                t.vocabulary_revision != ctx.vocabulary_revision
                for t in self.ws.project.transcripts
            ),
        }

    def set_vocabulary(
        self,
        *,
        terms: list[str],
        guest_names: list[str],
        base_revision: str | None,
    ) -> dict[str, Any]:
        """Save terms and guest names.

        Raises ValueError for invalid or prompt-overflowing vocabulary,
        VocabularyConflictError when ``base_revision`` is stale, and filelock.Timeout
        when the lock is busy.
        """
        cleaned_terms = _clean_vocabulary(terms)
        cleaned_names = _clean_vocabulary(guest_names)
        workspace = self.ws.project.workspace_path()
        with context_lock(workspace):
            current = load_transcript_context(workspace)
            if base_revision != current.vocabulary_revision:
                raise VocabularyConflictError(
                    "Vocabulary changed in another window; reload it before saving"
                )
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
    if len(cleaned) > VOCABULARY_MAX_ENTRIES or any(
        not value or len(value) > VOCABULARY_MAX_ENTRY_CHARS for value in cleaned
    ):
        raise ValueError(
            f"Vocabulary allows up to {VOCABULARY_MAX_ENTRIES} non-empty entries of "
            f"{VOCABULARY_MAX_ENTRY_CHARS} characters each"
        )
    return list(dict.fromkeys(cleaned))


def _ensure_prompt_covers_vocabulary(ctx: TranscriptContext) -> None:
    """Raise ValueError when the Whisper prompt would truncate saved vocabulary.

    Skipped when prompting is disabled: terms and names still feed the refine
    glossary even though no prompt is sent.
    """
    if not ctx.initial_prompt_enabled():
        return
    used = len(ctx.full_prompt_text())
    limit = ctx.initial_prompt_limit()
    if used > limit:
        raise ValueError(
            f"Vocabulary needs {used} Whisper prompt characters but the prompt limit is "
            f"{limit}; remove terms or guest names, or raise "
            "transcribe.initial_prompt_max_chars"
        )
