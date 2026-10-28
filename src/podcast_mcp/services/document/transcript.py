"""Transcript words: timing, corrections, suppression and cleanup."""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

from podcast_mcp.config.defaults import unsure_word_confidence
from podcast_mcp.edits.transcript_correct import (
    TranscriptTextChangedError,
    apply_transcript_corrections,
    correct_phrase,
    correct_word,
    list_low_confidence,
    require_word_text,
    run_user_transcript_edit,
    set_word_automatic,
    set_word_suppressed,
    set_words_ignored,
    verify_words,
)
from podcast_mcp.edits.transcript_cuts import format_transcript_timestamps
from podcast_mcp.edits.transcript_replace import (
    apply_transcript_replacement,
    plan_transcript_replacement,
)
from podcast_mcp.edits.transcript_reuse import plan_transcription, run_transcribe_plan
from podcast_mcp.edits.transcript_timing import (
    TranscriptTimingChangedError,
    WordTimingTarget,
    apply_word_timing,
    timing_transcript,
    validate_word_timing,
    word_timing_context,
)
from podcast_mcp.edits.unsure_words import unsure_predicate
from podcast_mcp.engines import TranscriptionEngine
from podcast_mcp.engines.models.registry import require_model
from podcast_mcp.engines.models.whisper import resolve_whisper_model
from podcast_mcp.engines.transcribe import dialogue_transcribe_jobs, track_transcribe_job
from podcast_mcp.export.transcript import CaptionLimits, write_combined_transcript_markdown
from podcast_mcp.models import CombinedTranscript, EpisodeProject, Transcript, TranscriptWord
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.service_base import WorkspaceService
from podcast_mcp.util.project_state import render_lock

from .transcript_timing import word_timing_media

log = logging.getLogger(__name__)
T = TypeVar("T")


def _user_transcript_edit(
    track_id: str, fn: Callable[[EpisodeProject], T], source_id: str | None = None
) -> Callable[[EpisodeProject], T]:
    """``ws.mutate`` callback: run ``fn`` as a user edit of one of ``track_id``'s transcripts."""

    def run(p: EpisodeProject) -> T:
        return run_user_transcript_edit(p, track_id, fn, source_id)

    return run


class TranscriptService(WorkspaceService):
    def __init__(self, workspace: ProjectWorkspace, *, model: str | None = None) -> None:
        super().__init__(workspace)
        self._model = model
        self._asr: TranscriptionEngine | None = None

    @property
    def _engine(self) -> TranscriptionEngine:
        """The ASR engine, built on first use so word edits never resolve a Whisper model."""
        if self._asr is None:
            self._asr = TranscriptionEngine(
                resolve_whisper_model(requested=self._model), defaults=self.ws.effective_config()
            )
        return self._asr

    def transcribe(self, track_id: str | None = None) -> list[str]:
        from podcast_mcp.edits.word_spans import trim_project_word_spans
        from podcast_mcp.services.pipeline import asr_options_for, run_defaults_for

        # Same transcribe.* settings as pipeline_run (staged working set, else defaults).
        self._engine.options = asr_options_for(self.ws.path)
        require_model("whisper", self._engine.model_size)
        defaults = run_defaults_for(self.ws.path)
        # Same fail-fast as transcribe_tracks: forced alignment explicitly on needs a model
        # that verifies and loads, before any transcript changes.
        self._engine.options.forced_alignment.require()
        if self._engine.options.forced_alignment.requested is True:
            self._engine.load_word_aligner()

        def mutate(p) -> list[str]:
            jobs = [track_transcribe_job(p, track_id)] if track_id else dialogue_transcribe_jobs(p)
            # An explicit transcribe is an attended overwrite: edited transcripts are
            # replaced with a warning, never silently, and nothing else is touched.
            plan = plan_transcription(p, jobs, overwrite=True, unattended=False)
            # The ASR disk cache still counts (docs/transcript-workflow.md): unchanged
            # audio, model and prompt reuse it.
            transcripts = run_transcribe_plan(
                p,
                plan,
                lambda: self._engine,
                use_cache=True,
                language=self._engine.options.language,
            )
            # Word times are final here, as at the end of the transcribe_tracks step.
            trim_project_word_spans(p, defaults)
            return list(dict.fromkeys(t.track_id for t in transcripts))

        return self.ws.mutate("before transcribe", "after transcribe", mutate)

    def seed(self, canned: dict) -> list[str]:
        """Replace the transcripts with canned ``per_track`` JSON (plus ``combined`` when given)."""
        per = [Transcript.model_validate(t) for t in canned.get("per_track", [])]
        with self.ws.transaction() as p:
            p.transcripts = per
            combined = canned.get("combined")
            p.combined_transcript = (
                CombinedTranscript.model_validate(combined)
                if combined
                else self._engine.merge_transcripts(p)
            )
            self.ws.save()
        return [t.track_id for t in per]

    def get(
        self,
        *,
        combined: bool = False,
        format: str = "json",
    ) -> str:
        p = self.ws.project
        if format == "timestamps":
            return format_transcript_timestamps(p, defaults=self.ws.effective_config())
        if combined:
            transcript = p.combined_transcript or self._engine.merge_transcripts(p)
            return transcript.model_dump_json(indent=2)
        import json

        return json.dumps([t.model_dump() for t in p.transcripts], indent=2)

    def export_markdown(self) -> Path:
        with render_lock(self.ws.project), self.ws.transaction() as p:
            if not p.combined_transcript:
                p.combined_transcript = self._engine.merge_transcripts(p)
            out = write_combined_transcript_markdown(p, self.ws.effective_config())
            self.ws.save()
        return out

    def export_subtitles(self, fmt: str = "srt", *, limits: CaptionLimits | None = None) -> Path:
        from podcast_mcp.export.names import sanitize_export_stem
        from podcast_mcp.export.transcript import utterances_to_srt, utterances_to_vtt

        with render_lock(self.ws.project), self.ws.transaction() as p:
            if not p.combined_transcript:
                p.combined_transcript = self._engine.merge_transcripts(p)
            p.export_dir().mkdir(parents=True, exist_ok=True)
            if fmt == "vtt":
                out = p.export_dir() / f"{sanitize_export_stem(p.name)}.vtt"
                out.write_text(utterances_to_vtt(p, limits=limits), encoding="utf-8")
            else:
                out = p.export_dir() / f"{sanitize_export_stem(p.name)}.srt"
                out.write_text(utterances_to_srt(p, limits=limits), encoding="utf-8")
            self.ws.save()
        return out

    def _guarded_transcript_edit(
        self,
        label: str,
        track_id: str,
        start_word_index: int,
        end_word_index: int,
        expected_text: str | None,
        edit: Callable[[EpisodeProject], T],
        source_id: str | None = None,
    ) -> T:
        """Check ``expected_text`` (#650) and apply ``edit`` in one transaction.

        ``transaction()`` is reentrant, so ``require_word_text`` and the nested ``mutate``
        share one critical section; a stale text raises before mutation or history. Returns
        ``edit``'s result.
        """
        with self.ws.transaction() as project:
            require_word_text(
                project, track_id, start_word_index, end_word_index, expected_text, source_id
            )
            return self.ws.mutate(
                f"before {label}",
                f"after {label}",
                _user_transcript_edit(track_id, edit, source_id),
            )

    def word_timing_context(
        self,
        target: WordTimingTarget,
        *,
        expected_text: str | None = None,
        expected_start: float | None = None,
        expected_end: float | None = None,
    ) -> dict[str, Any]:
        """Timing context and token for one word; each given expected value must still hold."""
        with self.ws.transaction() as project:
            transcript = timing_transcript(project, target)
            word = transcript.words[target.word_index]
            expected = (expected_text, expected_start, expected_end)
            actual = (word.text, word.start, word.end)
            if any(e is not None and e != a for e, a in zip(expected, actual, strict=True)):
                raise TranscriptTimingChangedError(
                    "This word changed. Select it again before adjusting timing."
                )
            return word_timing_context(project, target, word_timing_media(project, target))

    def set_word_timing(
        self, target: WordTimingTarget, expected_token: str, start: float, end: float
    ) -> dict[str, Any]:
        with self.ws.transaction() as project:
            timing_transcript(project, target)
            try:
                media = word_timing_media(project, target)
            except (OSError, KeyError) as exc:
                raise TranscriptTimingChangedError(
                    "This recording is unavailable. Reopen Adjust timing."
                ) from exc
            changed = validate_word_timing(project, target, media, expected_token, start, end)
            if changed:
                self.ws.mutate(
                    "before adjust word timing",
                    "after adjust word timing",
                    lambda p: apply_word_timing(
                        p, target, start, end, defaults=self.ws.effective_config()
                    ),
                )
            return {"changed": changed, "context": word_timing_context(project, target, media)}

    def preview_transcript_replacement(
        self, search: str, replacement: str, *, match_case: bool = False
    ) -> dict[str, Any]:
        with self.ws.transaction() as project:
            return plan_transcript_replacement(
                project, search, replacement, match_case=match_case
            ).preview()

    def replace_transcript_matches(
        self, search: str, replacement: str, preview_token: str, *, match_case: bool = False
    ) -> int:
        with self.ws.transaction() as project:
            plan = plan_transcript_replacement(project, search, replacement, match_case=match_case)
            if plan.token != preview_token:
                raise TranscriptTextChangedError(
                    "Transcript changed since the preview. Preview again before replacing."
                )
            if not plan.matches:
                return 0
            return self.ws.mutate(
                "before replace transcript matches",
                "after replace transcript matches",
                lambda p: apply_transcript_replacement(
                    p, plan, defaults=self.ws.effective_config()
                ),
            )

    def correct_word(
        self,
        track_id: str,
        word_index: int,
        new_text: str,
        *,
        expected_text: str | None = None,
        source_id: str | None = None,
    ) -> None:
        """Fix one word's text. ``expected_text`` guards against a stale index (#650)."""
        self._guarded_transcript_edit(
            "correct word",
            track_id,
            word_index,
            word_index,
            expected_text,
            lambda p: correct_word(
                p, track_id, word_index, new_text, source_id, defaults=self.ws.effective_config()
            ),
            source_id,
        )

    def correct_phrase(
        self,
        track_id: str,
        start_word_index: int,
        end_word_index: int,
        new_text: str,
        *,
        expected_text: str | None = None,
        source_id: str | None = None,
    ) -> None:
        """Replace a word range's text. ``expected_text`` guards against stale indices (#650)."""
        self._guarded_transcript_edit(
            "correct phrase",
            track_id,
            start_word_index,
            end_word_index,
            expected_text,
            lambda p: correct_phrase(
                p,
                track_id,
                start_word_index,
                end_word_index,
                new_text,
                source_id,
                defaults=self.ws.effective_config(),
            ),
            source_id,
        )

    def set_word_suppressed(
        self,
        track_id: str,
        word_index: int,
        suppressed: bool,
        *,
        expected_text: str | None = None,
        source_id: str | None = None,
    ) -> dict:
        """Toggle suppressed on one word. ``expected_text`` guards against a stale index (#744)."""
        return self._guarded_transcript_edit(
            "set word suppressed",
            track_id,
            word_index,
            word_index,
            expected_text,
            lambda p: set_word_suppressed(
                p, track_id, word_index, suppressed, source_id, defaults=self.ws.effective_config()
            ),
            source_id,
        )

    def set_word_automatic(
        self,
        track_id: str,
        word_index: int,
        *,
        expected_text: str | None = None,
        source_id: str | None = None,
    ) -> dict:
        """Clear a word's suppression lock; ``suppressed`` waits for the next reconcile (#824).

        ``expected_text`` guards against a stale index the same as ``set_word_suppressed``.
        """
        return self._guarded_transcript_edit(
            "return word to automatic",
            track_id,
            word_index,
            word_index,
            expected_text,
            lambda p: set_word_automatic(p, track_id, word_index, source_id),
            source_id,
        )

    def set_words_ignored(
        self,
        track_id: str,
        start_word_index: int,
        end_word_index: int,
        ignored: bool,
        *,
        expected_text: str | None = None,
        source_id: str | None = None,
    ) -> dict:
        """Text-and-audio hide for a word range, muted at render without a cut (#633).

        ``expected_text`` guards against a stale index range (#744).
        """
        return self._guarded_transcript_edit(
            "set words ignored",
            track_id,
            start_word_index,
            end_word_index,
            expected_text,
            lambda p: set_words_ignored(
                p, track_id, start_word_index, end_word_index, ignored, source_id
            ),
            source_id,
        )

    def low_confidence_words(self, threshold: float | None = None) -> list[dict]:
        """Unsure words; ``None`` uses the project's ``analysis.unsure_word_confidence``."""
        return list_low_confidence(
            self.ws.project, self.unsure_threshold() if threshold is None else threshold
        )

    def unsure_threshold(self) -> float:
        """The project's one unsure-word line (``analysis.unsure_word_confidence``)."""
        return unsure_word_confidence(self.ws.effective_config())

    def unsure_predicate(self) -> Callable[[TranscriptWord], bool]:
        """Whether a word is unsure at :meth:`unsure_threshold`, for mapping many words."""
        return unsure_predicate(self.unsure_threshold())

    def verify_transcript(
        self,
        track_id: str,
        corrections: list[dict[str, Any]],
    ) -> int:
        def mutate(p) -> int:
            return verify_words(p, track_id, corrections, defaults=self.ws.effective_config())

        return self.ws.mutate(
            "before verify transcript",
            "after verify transcript",
            _user_transcript_edit(track_id, mutate),
        )

    def apply_transcript_cleanup(
        self,
        track_id: str,
        *,
        words: list[dict[str, Any]] | None = None,
        phrases: list[dict[str, Any]] | None = None,
    ) -> int:
        """History-safe batch: word + phrase corrections in one undo step."""

        def mutate(p) -> int:
            return apply_transcript_corrections(
                p, track_id, words=words, phrases=phrases, defaults=self.ws.effective_config()
            )

        return self.ws.mutate(
            "before transcript cleanup",
            "after transcript cleanup",
            _user_transcript_edit(track_id, mutate),
        )
