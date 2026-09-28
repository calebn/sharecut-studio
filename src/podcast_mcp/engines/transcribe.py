from __future__ import annotations

import hashlib
import json
import logging
import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar

from podcast_mcp.config import whisper_cache_dir
from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.asr_silence import refresh_silence_flags, silence_filter_fingerprint
from podcast_mcp.engines.asr_timing import (
    ANOMALOUS_WORD_DURATION_REASON,
    DEFAULT_MAX_WORD_DURATION_SEC,
    word_duration_is_anomalous,
)
from podcast_mcp.models import (
    CombinedTranscript,
    CombinedUtterance,
    EpisodeProject,
    TrackRole,
    Transcript,
    TranscriptKey,
    TranscriptWord,
)
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.progress import (
    ProgressReporter,
    raise_if_cancel_requested,
    resolve_progress_task,
)
from podcast_mcp.util.project_state import current_cancel_check
from podcast_mcp.util.workspace_paths import resolve_under_workspace, resolve_within
from podcast_mcp.whisper_models import (
    DEFAULT_WHISPER_MODEL,
    ensure_whisper_model_cached,
    validate_whisper_model,
)

if TYPE_CHECKING:
    from podcast_mcp.engines.word_align import WordAligner, WordAlignResult

log = logging.getLogger(__name__)

TRANSCRIBE_CANCELLED = "Transcription cancelled"

_T = TypeVar("_T")


def cache_id_part(raw: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_-]+", raw):
        return raw
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class TranscribeJob:
    track_id: str
    source_id: str | None
    audio: Path

    @property
    def key(self) -> TranscriptKey:
        return (self.track_id, self.source_id)

    @property
    def cache_id(self) -> str:
        if self.source_id is None:
            return self.track_id
        return f"{self.track_id}__{self.source_id}"

    @property
    def label(self) -> str:
        if self.source_id is None:
            return f"Track {self.track_id}"
        return f"Track {self.track_id} source {self.source_id}"


def dialogue_transcribe_jobs(project: EpisodeProject) -> list[TranscribeJob]:
    """Primary track media first, then extra whole-file clip sources, deduplicated."""
    dialogue = [t for t in project.tracks if t.role == TrackRole.DIALOGUE and t.media]
    primary_jobs: list[TranscribeJob] = []
    extra_jobs: list[TranscribeJob] = []
    for track in dialogue:
        media = track.media
        if media is None:
            continue
        primary = resolve_under_workspace(project, media.path)
        primary_jobs.append(TranscribeJob(track.id, None, primary))
        for clip in project.clips:
            source_id = clip.source_id
            if clip.track_id != track.id or not source_id:
                continue
            src = project.source_by_id(source_id)
            if src is None:
                continue
            path = resolve_under_workspace(project, src.path)
            if path != primary and path.is_file():
                extra_jobs.append(TranscribeJob(track.id, source_id, path))
    seen: set[TranscriptKey] = set()
    jobs: list[TranscribeJob] = []
    for job in [*primary_jobs, *extra_jobs]:
        if job.key not in seen:
            seen.add(job.key)
            jobs.append(job)
    return jobs


def track_transcribe_job(project: EpisodeProject, track_id: str) -> TranscribeJob:
    """The primary-media job for one track (any role)."""
    track = project.track_by_id(track_id)
    if not track or not track.media:
        raise ValueError(f"track {track_id} not found or has no media")
    return TranscribeJob(track_id, None, resolve_under_workspace(project, track.media.path))


def _info_duration(info: Any) -> float | None:
    raw = getattr(info, "duration", None)
    if isinstance(raw, (int, float)) and raw > 0:
        return float(raw)
    return None


def _cache_file(project: EpisodeProject, cache_id: str, name: str) -> Path:
    try:
        return resolve_within(project.transcripts_dir(), name)
    except ValueError:
        raise ValueError(f"transcript cache escaped transcripts dir: {cache_id}") from None


def legacy_cache_path(project: EpisodeProject, cache_id: str, audio_sha256: str) -> Path:
    """Pre-model/prompt cache name ``{id}_{audio16}.json`` (read-only fallback)."""
    return _cache_file(project, cache_id, f"{cache_id_part(cache_id)}_{audio_sha256[:16]}.json")


def _read_json_cache(path: Path, what: str, parse: Callable[[Any], _T]) -> _T | None:
    """``parse`` of a JSON cache file, or None (miss) when absent or unreadable."""
    if not path.is_file():
        return None
    try:
        return parse(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, KeyError, TypeError, IndexError) as exc:
        # json.JSONDecodeError and pydantic.ValidationError are ValueErrors.
        log.warning("ignoring unreadable %s %s: %s", what, path.name, exc)
        return None


def _read_cache(path: Path) -> Transcript | None:
    return _read_json_cache(path, "transcript cache", Transcript.model_validate)


def _parse_align_spans(data: Any) -> list[tuple[float, float] | None]:
    return [None if s is None else (float(s[0]), float(s[1])) for s in data["spans"]]


def _read_align_cache(path: Path, count: int) -> list[tuple[float, float] | None] | None:
    """Cached aligned spans, or None (miss) when absent, unreadable or not matching ``count``."""
    spans = _read_json_cache(path, "word-alignment cache", _parse_align_spans)
    if spans is None:
        return None
    if len(spans) != count or any(s is not None and not 0 <= s[0] < s[1] for s in spans):
        log.warning("ignoring mismatched word-alignment cache %s", path.name)
        return None
    return spans


def _write_align_cache(
    path: Path, asr_cache: Path, aligner: WordAligner, result: WordAlignResult
) -> None:
    """Best-effort: the cache only saves a re-align, so a failed write keeps the aligned spans."""
    try:
        write_text_atomic(
            path,
            json.dumps(
                {
                    "aligner": aligner.cache_identity(),
                    "spans": [None if s is None else list(s) for s in result.spans],
                    "stats": result.stats.as_dict(),
                    "runtime_sec": round(result.runtime_sec, 3),
                },
                indent=2,
            ),
        )
        # One live sidecar per ASR cache: older words / aligner identities are stale.
        for stale in path.parent.glob(f"{asr_cache.stem}.word_align_*.json"):
            if stale != path:
                stale.unlink(missing_ok=True)
    except OSError as exc:
        log.warning("could not update word-alignment cache %s: %s", path.name, exc)


_CACHE_AUDIO_KEY = r"_([0-9a-f]{16})(?:_[0-9a-f]{16})?\.json"


def cached_audio_keys(project: EpisodeProject, cache_id: str) -> set[str]:
    """16-hex audio keys of the ASR caches (new and legacy names) stored for ``cache_id``."""
    tdir = project.transcripts_dir()
    if not tdir.is_dir():
        return set()
    pattern = re.compile(re.escape(cache_id_part(cache_id)) + _CACHE_AUDIO_KEY)
    keys: set[str] = set()
    for path in tdir.iterdir():
        match = pattern.fullmatch(path.name)
        if match:
            keys.add(match.group(1))
    return keys


def flag_anomalous_asr_durations(
    words: list[TranscriptWord],
    *,
    max_word_sec: float = DEFAULT_MAX_WORD_DURATION_SEC,
    track_id: str | None = None,
    mutate: bool = True,
) -> list[dict[str, Any]]:
    """Mark stretched ASR tokens as deferred without changing start/end.

    Whisper sometimes emits one token spanning many seconds of real speech.
    Clamping ``end`` would invent false boundaries; instead keep timestamps
    and surface the span for refine / audition.
    """
    flags: list[dict[str, Any]] = []
    for i, w in enumerate(words):
        dur = w.end - w.start
        if not word_duration_is_anomalous(dur, max_word_sec):
            continue
        # Only fill None; a rescan does not upgrade an existing status.
        if mutate and w.audibility_status is None:
            w.audibility_status = "deferred"
        entry: dict[str, Any] = {
            "word_index": i,
            "text": w.text,
            "start": w.start,
            "end": w.end,
            "duration_sec": round(dur, 3),
            "reason": ANOMALOUS_WORD_DURATION_REASON,
        }
        if track_id is not None:
            entry["track_id"] = track_id
        flags.append(entry)
    return flags


def collect_anomalous_asr_duration_flags(
    project: EpisodeProject,
    *,
    max_word_sec: float = DEFAULT_MAX_WORD_DURATION_SEC,
    mutate: bool = True,
) -> list[dict[str, Any]]:
    """Scan project transcripts for stretched words (flag-only; no time rewrite)."""
    flags: list[dict[str, Any]] = []
    for tr in project.transcripts:
        flags.extend(
            flag_anomalous_asr_durations(
                tr.words,
                max_word_sec=max_word_sec,
                track_id=tr.track_id,
                mutate=mutate,
            )
        )
    return flags


class TranscriptionEngine:
    def __init__(
        self,
        model_size: str = DEFAULT_WHISPER_MODEL,
        device: str = "cpu",
        options: AsrOptions | None = None,
    ) -> None:
        self.model_size = validate_whisper_model(model_size)
        self.device = device
        self.options = options if options is not None else AsrOptions.from_defaults()
        self._model = None
        # Job labels whose silence filter could not decode the audio (step summary).
        self.silence_filter_skipped: list[str] = []
        # Per-job forced-alignment outcomes (transcribe.forced_alignment); read by the step summary.
        self.forced_alignment_jobs: list[dict[str, Any]] = []
        self._word_aligner: WordAligner | None = None
        self._word_aligner_error: Exception | None = None

    def _get_model(self):
        if self._model is None:
            from faster_whisper import WhisperModel

            ensure_whisper_model_cached(self.model_size)
            self._model = WhisperModel(
                self.model_size,
                device=self.device,
                compute_type="int8" if self.device == "cpu" else "float16",
                download_root=str(whisper_cache_dir()),
                local_files_only=True,
            )
        return self._model

    def cache_path(
        self,
        project: EpisodeProject,
        track_id: str,
        audio_path: Path,
        *,
        language: str | None = None,
        initial_prompt: str | None = None,
        audio_sha256: str | None = None,
    ) -> Path:
        audio_key = (audio_sha256 or sha256_file(audio_path))[:16]
        inputs = json.dumps(
            {
                "model": self.model_size,
                "language": language,
                "initial_prompt": initial_prompt,
                "decode": self.options.decode_key(),
            },
            sort_keys=True,
        )
        inputs_key = hashlib.sha256(inputs.encode()).hexdigest()[:16]
        name = f"{cache_id_part(track_id)}_{audio_key}_{inputs_key}.json"
        return _cache_file(project, track_id, name)

    def _load_word_aligner(self) -> WordAligner:
        # The load, or its failure, is kept for this engine's lifetime (one pipeline run or
        # one TranscriptService request): a corrupt snapshot is hashed once per run, not
        # once per track, and a bootstrap in a long-lived process (Studio) still takes
        # effect on the next run. Not locked: an engine runs its jobs one at a time. Add a
        # lock if jobs ever run in parallel over one engine.
        if self._word_aligner_error is not None:
            raise self._word_aligner_error
        if self._word_aligner is None:
            from podcast_mcp.engines.word_align import WordAligner

            try:
                self._word_aligner = WordAligner.load()
            except Exception as exc:
                self._word_aligner_error = exc
                raise
        return self._word_aligner

    def word_align_cache_path(
        self,
        project: EpisodeProject,
        cache_id: str,
        asr_cache: Path,
        aligner: WordAligner,
        words: list[TranscriptWord],
    ) -> Path:
        """Alignment cache beside the ASR cache: same audio/inputs key + aligner + Whisper's words."""
        key_src = json.dumps(
            {
                "aligner": aligner.cache_identity(),
                "words": [[w.text, w.start, w.end] for w in words],
            },
            sort_keys=True,
        )
        key = hashlib.sha256(key_src.encode()).hexdigest()[:16]
        return _cache_file(project, cache_id, f"{asr_cache.stem}.word_align_{key}.json")

    def _align_words(
        self,
        project: EpisodeProject,
        job: TranscribeJob,
        transcript: Transcript,
        asr_cache: Path,
        *,
        use_cache: bool,
    ) -> None:
        """Opt-in forced alignment; on any failure Whisper's times stay and the job is reported."""
        if not self.options.forced_alignment_enabled or not transcript.words:
            return
        from podcast_mcp.engines.word_align import apply_word_spans

        entry: dict[str, Any] = {"label": job.label, "track_id": job.track_id}
        self.forced_alignment_jobs.append(entry)

        def keep_whisper(status: str, reason: str) -> None:
            entry.update(
                status=status,
                reason=reason,
                aligned_words=0,
                unaligned_words=len(transcript.words),
            )
            log.warning(
                "%s: forced alignment %s, keeping Whisper timestamps: %s",
                job.label,
                status,
                reason,
            )

        try:
            aligner = self._load_word_aligner()
        except Exception as exc:  # missing model / onnxruntime / corrupt snapshot
            keep_whisper("failed", str(exc))
            return
        if not aligner.supports_language(transcript.language):
            keep_whisper(
                "skipped",
                f"{aligner.model.id} does not support language {transcript.language!r}",
            )
            return
        path = self.word_align_cache_path(
            project, job.cache_id, asr_cache, aligner, transcript.words
        )
        spans = _read_align_cache(path, len(transcript.words)) if use_cache else None
        status = "cached"
        align_sec: float | None = None
        if spans is None:
            status = "aligned"
            raise_if_cancel_requested(current_cancel_check(), TRANSCRIBE_CANCELLED)
            try:
                with resolve_progress_task("forced_alignment", f"Aligning words {job.label}"):
                    result = aligner.align(job.audio, transcript.words)
            except Exception as exc:  # decode / inference failure
                keep_whisper("failed", str(exc))
                return
            spans = result.spans
            align_sec = round(result.runtime_sec, 3)
            _write_align_cache(path, asr_cache, aligner, result)
        retimed = apply_word_spans(transcript.words, spans)
        if not retimed:
            keep_whisper("failed", "no words aligned")
            return
        entry.update(
            status=status,
            aligned_words=retimed,
            unaligned_words=len(transcript.words) - retimed,
        )
        if align_sec is not None:
            entry["align_sec"] = align_sec
        transcript.word_aligner = aligner.model.id

    def transcribe_file(
        self,
        audio_path: Path,
        language: str | None = "en",
        *,
        initial_prompt: str | None = None,
        max_word_sec: float = DEFAULT_MAX_WORD_DURATION_SEC,
        progress_label: str | None = None,
    ) -> Transcript:
        model = self._get_model()
        kwargs: dict = {
            "language": language,
            "word_timestamps": True,
            **self.options.transcribe_kwargs(initial_prompt),
        }
        segments, info = model.transcribe(str(audio_path), **kwargs)
        duration = _info_duration(info)
        total = math.ceil(duration) if duration else None
        label = progress_label or audio_path.name
        words: list[TranscriptWord] = []
        with resolve_progress_task(
            "transcribe_audio", f"Transcribing {label}", total=total
        ) as task:
            for segment in segments:
                if segment.words:
                    for w in segment.words:
                        words.append(
                            TranscriptWord(
                                text=(w.word or "").strip(),
                                start=float(w.start),
                                end=float(w.end),
                                confidence=getattr(w, "probability", None),
                            )
                        )
                else:
                    text = (segment.text or "").strip()
                    if text:
                        words.append(
                            TranscriptWord(
                                text=text,
                                start=float(segment.start),
                                end=float(segment.end),
                            )
                        )
                if total is not None and duration:
                    done = int(min(float(segment.end), duration))
                    task.advance_to(done, message=f"{label}: {done}s of {total}s", total=total)
        flag_anomalous_asr_durations(words, max_word_sec=max_word_sec)
        return Transcript(track_id="", language=language or "en", words=words)

    def transcribe_job(
        self,
        project: EpisodeProject,
        job: TranscribeJob,
        language: str | None = None,
        use_cache: bool = True,
        *,
        initial_prompt: str | None = None,
        max_word_sec: float = DEFAULT_MAX_WORD_DURATION_SEC,
        audio_sha256: str | None = None,
    ) -> Transcript:
        """Transcribe one job: new cache, legacy cache (no prompt only), then ASR.

        use_cache=False skips both caches.
        """
        sha = audio_sha256 or sha256_file(job.audio)
        cache = self.cache_path(
            project,
            job.cache_id,
            job.audio,
            language=language,
            initial_prompt=initial_prompt,
            audio_sha256=sha,
        )
        transcript: Transcript | None = None
        if use_cache:
            transcript = _read_cache(cache)
            # The legacy name does not encode model or prompt, so it is only
            # trusted when no prompt shaped the words and decoding matches
            # faster-whisper's own defaults (VAD / temperature change the words).
            if transcript is None and not initial_prompt and self.options.is_faster_whisper_default:
                transcript = _read_cache(legacy_cache_path(project, job.cache_id, sha))
        fresh = transcript is None
        if transcript is None:
            transcript = self.transcribe_file(
                job.audio,
                language=language,
                initial_prompt=initial_prompt,
                max_word_sec=max_word_sec,
                progress_label=job.label,
            )
        transcript.track_id = job.track_id
        transcript.source_id = job.source_id
        transcript.audio_sha256 = sha
        # Whisper's own times until _align_words re-times them (the ASR cache never holds a marker).
        transcript.word_aligner = None
        # Cached words carry no silence flags: they are recomputed below from the current
        # transcribe.silence_filter settings (not a cache input) on every read.
        for word in transcript.words:
            word.suspect_hallucination = False
        if fresh:
            # Whisper's own times (transcribe_file already flagged them with this
            # max_word_sec); alignment has its own cache, so the flag never re-runs Whisper.
            write_text_atomic(cache, transcript.model_dump_json(indent=2))
        self._align_words(project, job, transcript, cache, use_cache=use_cache)
        # Backstop on the final spans (aligned, or Whisper's where alignment was off/failed).
        flag_anomalous_asr_durations(
            transcript.words, max_word_sec=max_word_sec, track_id=job.track_id
        )
        n = refresh_silence_flags(transcript.words, job.audio, self.options)
        if n is None:
            self.silence_filter_skipped.append(job.label)
            transcript.silence_filter_fingerprint = None
        else:
            transcript.silence_filter_fingerprint = silence_filter_fingerprint(
                transcript.words, sha, self.options
            )
        if n:
            log.info("%s: %d word(s) over silence flagged suspect_hallucination", job.label, n)
        return transcript

    def transcribe_track(
        self,
        project: EpisodeProject,
        track_id: str,
        language: str | None = None,
        use_cache: bool = True,
        *,
        initial_prompt: str | None = None,
        max_word_sec: float = DEFAULT_MAX_WORD_DURATION_SEC,
    ) -> Transcript:
        return self.transcribe_job(
            project,
            track_transcribe_job(project, track_id),
            language=language,
            use_cache=use_cache,
            initial_prompt=initial_prompt,
            max_word_sec=max_word_sec,
        )

    def transcribe_all_dialogue(
        self,
        project: EpisodeProject,
        language: str | None = None,
        *,
        initial_prompt: str | None = None,
        progress: ProgressReporter | None = None,
        max_word_sec: float = DEFAULT_MAX_WORD_DURATION_SEC,
        jobs: list[TranscribeJob] | None = None,
        audio_hashes: dict[TranscriptKey, str] | None = None,
        use_cache: bool = True,
    ) -> list[Transcript]:
        job_list = dialogue_transcribe_jobs(project) if jobs is None else jobs
        hashes = audio_hashes or {}
        total = max(len(job_list), 1)
        results: list[Transcript] = []
        with resolve_progress_task(
            "transcribe",
            "Transcribing tracks",
            total=total,
            prefer_parent=True,
            progress=progress,
        ) as task:
            for job in job_list:
                raise_if_cancel_requested(current_cancel_check(), TRANSCRIBE_CANCELLED)
                task.set_phase("track" if job.source_id is None else "source", job.label)
                results.append(
                    self.transcribe_job(
                        project,
                        job,
                        language=language,
                        initial_prompt=initial_prompt,
                        max_word_sec=max_word_sec,
                        audio_sha256=hashes.get(job.key),
                        use_cache=use_cache,
                    )
                )
                task.advance(1, message=job.label, total=total)
        return results

    def merge_transcripts(self, project: EpisodeProject) -> CombinedTranscript:
        utterances: list[CombinedUtterance] = []
        for transcript in project.transcripts:
            track = project.track_by_id(transcript.track_id)
            speaker = (track.speaker if track else None) or transcript.track_id
            if not transcript.words:
                continue
            buf: list[TranscriptWord] = []
            gap_threshold = 0.8

            def flush(
                *,
                _buf: list[TranscriptWord] = buf,
                _transcript: Transcript = transcript,
                _speaker: str = speaker,
            ) -> None:
                if not _buf:
                    return
                text = " ".join(w.text for w in _buf).strip()
                utterances.append(
                    CombinedUtterance(
                        track_id=_transcript.track_id,
                        speaker=_speaker,
                        start=_buf[0].start,
                        end=_buf[-1].end,
                        text=text,
                    )
                )
                _buf.clear()

            for word in transcript.words:
                if word.suppressed:
                    continue
                if buf and word.start - buf[-1].end > gap_threshold:
                    flush()
                buf.append(word)
            flush()

        utterances.sort(key=lambda u: u.start)
        return CombinedTranscript(utterances=utterances)
