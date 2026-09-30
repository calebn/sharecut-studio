from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from copy import deepcopy
from typing import Any

from filelock import Timeout

from podcast_mcp.edits.transcript_precorrect import run_precorrect_transcript
from podcast_mcp.engines.audio_audit import AnalysisPolicy
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.transcript_context import (
    DEFAULT_PROMPT_PRIMER,
    VOCABULARY_MAX_ENTRIES,
    VOCABULARY_MAX_ENTRY_CHARS,
    TranscriptContext,
    context_from_dict,
    context_lock,
    context_to_dict,
    load_transcript_context,
    new_vocabulary_revision,
)
from podcast_mcp.util.progress import ProgressReporter, resolve_progress
from podcast_mcp.util.project_state import TRANSCRIPT_CONTEXT_BUSY_MESSAGE


class VocabularyConflictError(RuntimeError):
    """Saved vocabulary changed after the caller read it (stale base_revision)."""


class TranscriptContextBusyError(RuntimeError):
    """Another writer holds the transcript context lock."""


class TranscriptPrecorrectService:
    def __init__(self, workspace: ProjectWorkspace) -> None:
        self.ws = workspace

    @contextmanager
    def _context_lock(self) -> Iterator[None]:
        try:
            with context_lock(self.ws.project.workspace_path()):
                yield
        except Timeout as exc:
            raise TranscriptContextBusyError(TRANSCRIPT_CONTEXT_BUSY_MESSAGE) from exc

    def load_context(self) -> TranscriptContext:
        return load_transcript_context(self.ws.project.workspace_path())

    def get_context(self) -> dict[str, Any]:
        return context_to_dict(self.load_context())

    def set_context(self, ctx: TranscriptContext) -> str:
        """Replace transcript_context.yaml with ``ctx`` under the context lock.

        Raises ValueError when changed vocabulary would be truncated in the Whisper prompt,
        and TranscriptContextBusyError when another writer holds the lock.
        """
        workspace = self.ws.project.workspace_path()
        with self._context_lock():
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
        remove_terms: list[str] | None = None,
        remove_guest_names: list[str] | None = None,
    ) -> str:
        """Merge values, append terms/names, then remove entries under the context lock.

        Raises ValueError when changed vocabulary would be truncated in the Whisper prompt,
        or when changed terms or guest names break the entry limits, and TranscriptContextBusyError
        when another writer holds the lock.
        """
        workspace = self.ws.project.workspace_path()
        with self._context_lock():
            current = load_transcript_context(workspace)
            merged = {**context_to_dict(current), **(values or {})}
            if terms:
                merged["terms"] = [*(merged.get("terms") or []), *terms]
            if guest_names:
                merged["guest_names"] = [*(merged.get("guest_names") or []), *guest_names]
            for key, removals in (("terms", remove_terms), ("guest_names", remove_guest_names)):
                if removals:
                    removed = set(_clean_vocabulary(removals))
                    merged[key] = [
                        str(value).strip()
                        for value in merged.get(key) or []
                        if str(value).strip() not in removed
                    ]
                if merged.get(key) != getattr(current, key):
                    merged[key] = _clean_vocabulary([str(v) for v in merged.get(key) or []])
            next_ctx = context_from_dict(merged)
            return self._save_context_locked(next_ctx, current)

    def get_vocabulary(self) -> dict[str, Any]:
        ctx = self.load_context()
        return {
            "terms": ctx.terms,
            "guest_names": ctx.guest_names,
            "show_title": ctx.show_title,
            "prompt_limit": ctx.initial_prompt_limit() if ctx.initial_prompt_enabled() else None,
            "prompt_primer": DEFAULT_PROMPT_PRIMER,
            "revision": ctx.vocabulary_revision,
            # No transcripts means nothing to re-transcribe; otherwise any row
            # produced with another revision (or before revisions) is stale.
            "needs_retranscription": any(
                t.vocabulary_revision != ctx.vocabulary_revision
                for t in self.ws.project.transcripts
            ),
            # Studio Re-transcribe names these and asks before replacing their hand edits.
            "edited_tracks": list(
                dict.fromkeys(t.track_id for t in self.ws.project.transcripts if t.user_edited)
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
        VocabularyConflictError when ``base_revision`` is stale, and TranscriptContextBusyError
        when the lock is busy.
        """
        cleaned_terms = _clean_vocabulary(terms)
        cleaned_names = _clean_vocabulary(guest_names)
        workspace = self.ws.project.workspace_path()
        with self._context_lock():
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
    glossary even though no prompt is sent. Compares against what the prompt
    actually sends (``initial_prompt_vocabulary_truncated``), not the untruncated
    primer-plus-vocabulary length: a limit below the primer's own length (27
    characters) always drops the vocabulary and sends the primer alone, which is
    not a rejectable overflow when the vocabulary itself is empty (#804).
    """
    if not ctx.initial_prompt_enabled():
        return
    if not ctx.initial_prompt_vocabulary_truncated():
        return
    used = len(ctx.primed_prompt_text())
    limit = ctx.initial_prompt_limit()
    raise ValueError(
        f"Vocabulary needs {used} Whisper prompt characters but the prompt limit is "
        f"{limit}; remove terms or guest names, or raise "
        "transcribe.initial_prompt_max_chars"
    )
