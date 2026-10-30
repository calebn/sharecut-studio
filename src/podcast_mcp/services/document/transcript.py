"""Transcript words: timing, corrections, suppression and cleanup."""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeVar

from podcast_mcp.config.defaults import EffectiveConfig, unsure_word_confidence
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
from podcast_mcp.edits.unsure_words import unsure_predicate, unsure_words_by_edit
from podcast_mcp.engines import TranscriptionEngine
from podcast_mcp.engines.models.registry import require_model
from podcast_mcp.engines.models.whisper import resolve_whisper_model
from podcast_mcp.engines.transcribe import dialogue_transcribe_jobs, track_transcribe_job
from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.export.transcript import (
    TRANSCRIPT_FORMATS,
    TRANSCRIPT_MIME,
    CaptionLimits,
    captions_match,
    first_cue_sample,
    render_reading_text,
    render_transcript_formats,
    resolve_caption_limits,
    timeline_utterances,
    transcript_language,
)
from podcast_mcp.models import (
    CombinedTranscript,
    EditDecision,
    EpisodeProject,
    Transcript,
    TranscriptWord,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document.service_base import WorkspaceService
from podcast_mcp.util.atomic_render import render_atomic_all
from podcast_mcp.util.coded_error import CodedError, CodedValueError
from podcast_mcp.util.project_state import (
    REQUEST_RENDER_LOCK_TIMEOUT_SEC,
    RenderBusyError,
    render_lock,
)

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


PREVIEW_TURNS = 6


class ExportBusyError(CodedError, RuntimeError):
    """Another render of this project holds the lock past the request timeout."""

    code = "export_busy"


class TranscriptEmptyError(CodedError, ValueError):
    """The edited episode has no transcript turns to write."""

    code = "transcript_empty"


@dataclass
class TranscriptPreviewTurn:
    speaker: str
    start_sec: float
    text: str


@dataclass
class TranscriptExportFile:
    format: str
    path: str
    name: str
    bytes: int
    language: str
    written: bool
    current: bool


@dataclass
class TranscriptExport:
    """Result of :meth:`TranscriptService.export`; the same JSON on every surface."""

    language: str
    turns: int
    duration_sec: float
    preview: list[TranscriptPreviewTurn]
    cue_sample: str | None
    files: list[TranscriptExportFile]
    text: str | None


@dataclass
class ExportedTranscript:
    format: str
    path: str
    name: str
    mime: str
    language: str
    bytes: int
    modified: str
    current: bool


def _validated_formats(formats: Sequence[str]) -> tuple[str, ...]:
    bad = [f for f in formats if f not in TRANSCRIPT_FORMATS]
    if bad:
        raise CodedValueError(
            f"Unknown transcript format {bad[0]!r}; use one of {', '.join(TRANSCRIPT_FORMATS)}.",
            code="invalid_format",
        )
    if not formats:
        raise CodedValueError("Choose at least one transcript format.", code="invalid_format")
    return tuple(dict.fromkeys(formats))


def _same_transcript(fmt: str, data: bytes, fresh: str, project: EpisodeProject) -> bool:
    if fmt in ("srt", "vtt"):
        return captions_match(data.decode("utf-8", errors="replace"), project)
    return data == fresh.encode("utf-8")


def _configured_limits(defaults: EffectiveConfig) -> CaptionLimits:
    return resolve_caption_limits(defaults.get("export", {}))


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

    def export(
        self,
        formats: Sequence[str],
        *,
        dry_run: bool = False,
        with_text: bool = False,
        limits: CaptionLimits | None = None,
    ) -> TranscriptExport:
        """Write the edited episode's transcript as ``formats`` (``txt|md|srt|vtt``), or preview it.

        Files land in ``export_dir()`` next to the audio, written to temporary files first, and a
        destination that is not a file is refused before any file is replaced. ``dry_run``
        takes no lock, writes nothing and returns the preview only; ``with_text`` adds the
        reading text. A real write of an episode with no turns raises ``transcript_empty``;
        a render held by another writer past the request timeout raises ``export_busy``.
        """
        wanted = _validated_formats(formats)
        if dry_run:
            return self._export_result(self.ws.project.model_copy(deep=True), with_text, limits)
        try:
            with (
                render_lock(self.ws.project, timeout=REQUEST_RENDER_LOCK_TIMEOUT_SEC),
                self.ws.transaction() as p,
            ):
                before = p.combined_transcript
                result = self._write_files(p, wanted, with_text, limits)
                if p.combined_transcript != before:
                    self.ws.save()
        except RenderBusyError as exc:
            raise ExportBusyError(
                "Another export of this project is running. Try again when it finishes."
            ) from exc
        return result

    def _write_files(
        self,
        p: EpisodeProject,
        formats: tuple[str, ...],
        with_text: bool,
        limits: CaptionLimits | None,
    ) -> TranscriptExport:
        defaults = self.ws.effective_config()
        limits = limits or _configured_limits(defaults)
        result = self._export_result(p, with_text, limits)
        if result.turns == 0:
            raise TranscriptEmptyError("Every word is cut. Nothing to export.")
        rendered = render_transcript_formats(p, defaults, formats, limits)
        stem = p.export_dir() / sanitize_export_stem(p.name)
        dests = [stem.with_name(f"{stem.name}.{fmt}") for fmt in rendered]
        blocked = next((d for d in dests if d.exists() and not d.is_file()), None)
        if blocked is not None:
            raise CodedValueError(
                f"{blocked.name} in the export folder is not a file; move it and export again.",
                code="export_target_not_file",
            )

        def render(temps: list[Path]) -> None:
            for tmp, content in zip(temps, rendered.values(), strict=True):
                tmp.write_text(content, encoding="utf-8")

        render_atomic_all(dests, render, reap_partials=True)
        result.files = [
            TranscriptExportFile(
                format=fmt,
                path=str(dest),
                name=dest.name,
                bytes=dest.stat().st_size,
                language=result.language,
                written=True,
                current=True,
            )
            for fmt, dest in zip(rendered, dests, strict=True)
        ]
        return result

    def _export_result(
        self,
        p: EpisodeProject,
        with_text: bool,
        limits: CaptionLimits | None,
    ) -> TranscriptExport:
        """The preview half of an export, rendered from ``p`` (which it may merge in memory)."""
        defaults = self.ws.effective_config()
        limits = limits or _configured_limits(defaults)
        turns = timeline_utterances(p, defaults)
        return TranscriptExport(
            language=transcript_language(p),
            turns=len(turns),
            duration_sec=max((u.end for u in turns), default=0.0),
            preview=[
                TranscriptPreviewTurn(speaker=u.speaker, start_sec=u.start, text=u.text)
                for u in turns[:PREVIEW_TURNS]
            ],
            cue_sample=first_cue_sample(p, limits),
            files=[],
            text=render_reading_text(p, defaults) if with_text else None,
        )

    def exported(self) -> list[ExportedTranscript]:
        """Transcript files in ``export_dir()`` for this project, read-only (no lock, no save).

        Only ``<stem>.{txt,md,srt,vtt}`` directly in the folder count, so ``bounces/`` and
        ``clips/`` never appear. ``current`` compares each file with a fresh render; captions
        compare by their words and cue start times, since the file does not record the cue limits.
        """
        p = self.ws.project
        stem = sanitize_export_stem(p.name)
        found = [
            (fmt, p.export_dir() / f"{stem}.{fmt}")
            for fmt in TRANSCRIPT_FORMATS
            if (p.export_dir() / f"{stem}.{fmt}").is_file()
        ]
        if not found:
            return []
        fresh = p.model_copy(deep=True)
        defaults = self.ws.effective_config()
        rendered = render_transcript_formats(
            fresh, defaults, [fmt for fmt, _ in found], _configured_limits(defaults)
        )
        language = transcript_language(fresh)
        out: list[ExportedTranscript] = []
        for fmt, path in found:
            try:
                data = path.read_bytes()
                mtime = path.stat().st_mtime
            except FileNotFoundError:
                continue
            out.append(
                ExportedTranscript(
                    format=fmt,
                    path=str(path),
                    name=path.name,
                    mime=TRANSCRIPT_MIME[fmt],
                    language=language,
                    bytes=len(data),
                    modified=datetime.fromtimestamp(mtime, tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    current=_same_transcript(fmt, data, rendered[fmt], fresh),
                )
            )
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

    def unsure_words_for(self, decisions: list[EditDecision]) -> dict[str, list[dict[str, Any]]]:
        """Each pending cut's unsure transcript words, by edit id (the ProjectView's `unsure_words`)."""
        return unsure_words_by_edit(self.ws.project, decisions, self.unsure_threshold())

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
