from __future__ import annotations

import hashlib
import json
import logging
import math
import re
from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager
from dataclasses import dataclass
from pathlib import Path
from stat import S_ISREG
from typing import TYPE_CHECKING, Any, TypeVar

from filelock import FileLock, Timeout

from podcast_mcp.config import whisper_cache_dir
from podcast_mcp.engines.asr_options import AsrOptions
from podcast_mcp.engines.asr_silence import (
    SpeechLevels,
    below_evidence_floor,
    evidence_applies,
    refresh_silence_flags,
    silence_filter_fingerprint,
)
from podcast_mcp.engines.asr_timing import (
    ANOMALOUS_WORD_DURATION_REASON,
    DEFAULT_MAX_WORD_DURATION_SEC,
    word_duration_is_anomalous,
)
from podcast_mcp.engines.utterance_runs import transcript_word_runs, utterance_text
from podcast_mcp.models import (
    CombinedTranscript,
    CombinedUtterance,
    EpisodeProject,
    TrackRole,
    Transcript,
    TranscriptKey,
    TranscriptWord,
)
from podcast_mcp.models.episode import workspace_artifacts_dir
from podcast_mcp.util.atomic_json import write_text_atomic
from podcast_mcp.util.file_locks import hold_shared_file_lock
from podcast_mcp.util.hashing import sha256_file
from podcast_mcp.util.progress import (
    ProgressReporter,
    raise_if_cancel_requested,
    resolve_progress_task,
)
from podcast_mcp.util.project_state import current_cancel_check
from podcast_mcp.util.workspace_paths import resolve_cache_file, resolve_under_workspace
from podcast_mcp.whisper_models import (
    DEFAULT_WHISPER_MODEL,
    resolve_whisper_model_path,
    validate_whisper_model,
)

if TYPE_CHECKING:
    from podcast_mcp.engines.word_align import WordAligner, WordAlignResult

log = logging.getLogger(__name__)

TRANSCRIBE_CANCELLED = "Transcription cancelled"
ASR_CACHE_VARIANTS = 2
ASR_CACHE_LOCK_TIMEOUT_SEC = 10.0

_T = TypeVar("_T")

# ``forced_alignment_jobs`` statuses where the aligner's times replaced Whisper's
# (set in ``_align_words``); ``keep_whisper`` records ``failed`` / ``skipped``.
ALIGNMENT_SUCCESS_STATUSES = frozenset({"aligned", "cached"})


def forced_alignment_succeeded(entry: Mapping[str, Any]) -> bool:
    """True when a ``forced_alignment_jobs`` entry re-timed at least one word."""
    return entry.get("status") in ALIGNMENT_SUCCESS_STATUSES and entry.get("aligned_words", 0) > 0


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


def _canonical_transcript_names(project: EpisodeProject) -> set[str]:
    return {
        "combined.json",
        *(f"{track.id}.json" for track in project.tracks),
        *(f"{transcript.track_id}.json" for transcript in project.transcripts),
    }


def _cache_file(project: EpisodeProject, cache_id: str, name: str) -> Path:
    if name in _canonical_transcript_names(project):
        raise ValueError(f"transcript cache collides with a canonical mirror: {cache_id}")
    directory = project.transcripts_dir()
    path = resolve_cache_file(directory, name, kind="transcript", cache_id=cache_id)
    if path != directory.resolve() / name:
        raise ValueError(f"transcript cache aliases another file: {cache_id}")
    return path


def _cache_publication_lock(
    project: EpisodeProject, asr_cache: Path
) -> AbstractContextManager[FileLock]:
    family = asr_cache.stem.rsplit("_", 1)[0]
    path = workspace_artifacts_dir(project.workspace_path()) / f"transcript-cache-{family}.lock"
    return hold_shared_file_lock(path, timeout=ASR_CACHE_LOCK_TIMEOUT_SEC)


def _prune_asr_cache(project: EpisodeProject, cache: Path) -> None:
    """Keep this ASR variant and one previous write in its exact job/audio family.

    Called under the family publication lock after a successful ASR write.
    Removes legacy names and alignment sidecars without a retained ASR parent.
    Symlinks, directories, other job/audio families and canonical mirrors are untouched.
    Cleanup failures do not discard the successful transcription.
    """
    family = re.escape(cache.stem.rsplit("_", 1)[0])
    pattern = re.compile(family + r"(?:_[0-9a-f]{16})?(?:\.word_align_[0-9a-f]{16})?\.json")
    protected = _canonical_transcript_names(project)
    files: list[tuple[Path, int]] = []
    try:
        for path in cache.parent.iterdir():
            if path.name in protected or not pattern.fullmatch(path.name):
                continue
            try:
                stat = path.lstat()
                if S_ISREG(stat.st_mode):
                    files.append((path, stat.st_mtime_ns))
            except FileNotFoundError:
                continue
        variants = sorted(
            (
                (path, mtime)
                for path, mtime in files
                if re.fullmatch(family + r"_[0-9a-f]{16}\.json", path.name) and path != cache
            ),
            key=lambda item: (item[1], item[0].name),
            reverse=True,
        )
        kept = {cache.stem, *(path.stem for path, _mtime in variants[: ASR_CACHE_VARIANTS - 1])}
        for path, _mtime in files:
            if path.name.partition(".word_align_")[0].removesuffix(".json") in kept:
                continue
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                log.warning("could not prune transcript cache %s: %s", path.name, exc)
    except OSError as exc:
        log.warning("could not scan transcript cache family %s: %s", cache.name, exc)


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


def _parse_align_cache(data: Any) -> tuple[list[tuple[float, float] | None], list[float | None]]:
    spans = [None if s is None else (float(s[0]), float(s[1])) for s in data["spans"]]
    scores = [None if s is None else float(s) for s in data["scores"]]
    return spans, scores


def _read_align_cache(
    path: Path, count: int
) -> tuple[list[tuple[float, float] | None], list[float | None]] | None:
    """Cached aligned spans + scores, or None (miss) when absent, unreadable or not matching ``count``."""
    parsed = _read_json_cache(path, "word-alignment cache", _parse_align_cache)
    if parsed is None:
        return None
    spans, scores = parsed
    valid = (
        len(spans) == count
        and len(scores) == count
        and all(s is not None or sc is None for s, sc in zip(spans, scores, strict=True))
        and all(s is None or 0 <= s[0] < s[1] for s in spans)
        and all(sc is None or 0.0 <= sc <= 1.0 for sc in scores)
    )
    if not valid:
        log.warning("ignoring mismatched word-alignment cache %s", path.name)
        return None
    return spans, scores


def _write_align_cache(
    project: EpisodeProject,
    path: Path,
    asr_cache: Path,
    aligner: WordAligner,
    result: WordAlignResult,
) -> None:
    """Best-effort: the cache only saves a re-align, so a failed write keeps the aligned spans."""
    try:
        with _cache_publication_lock(project, asr_cache):
            if not asr_cache.is_file():
                return
            write_text_atomic(
                path,
                json.dumps(
                    {
                        "aligner": aligner.cache_identity(),
                        "spans": [None if s is None else list(s) for s in result.spans],
                        "scores": list(result.scores)
                        if result.scores
                        else [None] * len(result.spans),
                        "stats": result.stats.as_dict(),
                        "runtime_sec": round(result.runtime_sec, 3),
                    },
                    indent=2,
                ),
            )
            # One live sidecar per ASR cache: older words / aligner identities are stale.
            protected = _canonical_transcript_names(project)
            for stale in path.parent.glob(f"{asr_cache.stem}.word_align_*.json"):
                if (
                    stale != path
                    and stale.name not in protected
                    and re.fullmatch(
                        re.escape(asr_cache.stem) + r"\.word_align_[0-9a-f]{16}\.json", stale.name
                    )
                    and not stale.is_symlink()
                    and stale.is_file()
                ):
                    stale.unlink(missing_ok=True)
    except (OSError, Timeout) as exc:
        log.warning("could not update word-alignment cache %s: %s", path.name, exc)


_CACHE_AUDIO_KEY = r"_([0-9a-f]{16})_[0-9a-f]{16}\.json"


def cached_audio_keys(project: EpisodeProject, cache_id: str) -> set[str]:
    """16-hex audio keys of the ASR caches stored for ``cache_id``."""
    tdir = project.transcripts_dir()
    if not tdir.is_dir():
        return set()
    pattern = re.compile(re.escape(cache_id_part(cache_id)) + _CACHE_AUDIO_KEY)
    protected = _canonical_transcript_names(project)
    keys: set[str] = set()
    for path in tdir.iterdir():
        match = pattern.fullmatch(path.name)
        if match and path.name not in protected and not path.is_symlink() and path.is_file():
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


PUNCTUATION_RATE_OUTLIER_REASON = "punctuation_rate_outlier"

# A track below this floor never trips the check: with everyone's rate this low
# (e.g. a language Whisper doesn't punctuate, or very short, filler-only tracks)
# there is no reliable peer baseline to compare against.
_PUNCTUATION_OUTLIER_MIN_PEER_RATE = 0.05
# Flag a track whose own rate is this fraction of its peers' average or less.
_PUNCTUATION_OUTLIER_RATIO = 0.25
# Below this many words, per-track punctuation rate is too noisy to trust: simulating a
# healthy 0.12-true-rate track against 0.17 peers false-flagged 5-11% of the time at
# 20-50 words and 0.5% at 100.
_PUNCTUATION_OUTLIER_MIN_WORDS = 100

# ASCII, then CJK/full-width IDEOGRAPHIC FULL STOP, FULLWIDTH EXCLAMATION MARK and
# FULLWIDTH QUESTION MARK (written by codepoint, not literally, so they can't be
# mistaken for their ASCII lookalikes when read in a diff).
_TERMINAL_MARKS = frozenset(".!?" + "".join(chr(cp) for cp in (0x3002, 0xFF01, 0xFF1F)))
# A word ending in a closing quote or bracket around real terminal punctuation
# ('."', ."]) must not read as unpunctuated: RIGHT SINGLE QUOTATION MARK, RIGHT DOUBLE
# QUOTATION MARK, SINGLE RIGHT-POINTING ANGLE QUOTATION MARK, RIGHT-POINTING DOUBLE
# ANGLE QUOTATION MARK.
_TRAILING_CLOSERS = "\"')]}" + "".join(chr(cp) for cp in (0x2019, 0x201D, 0x203A, 0x00BB))


def _end_punctuated(word: TranscriptWord) -> bool:
    text = word.text.rstrip().rstrip(_TRAILING_CLOSERS)
    return text[-1:] in _TERMINAL_MARKS


def track_punctuation_rate(words: list[TranscriptWord]) -> float | None:
    """Fraction of ``words`` ending in terminal punctuation; None below the minimum sample."""
    if len(words) < _PUNCTUATION_OUTLIER_MIN_WORDS:
        return None
    return sum(1 for w in words if _end_punctuated(w)) / len(words)


def collect_punctuation_outlier_flags(project: EpisodeProject) -> list[dict[str, Any]]:
    """Flag a dialogue track whose punctuation rate is far below its peers'.

    ``condition_on_previous_text`` can lock a track into an unpunctuated, uncased
    style for its whole length once its first decode window comes out that way
    (#769); this catches the result without redecoding anything. Needs at least
    two tracks with a large enough sample to have a peer baseline.
    """
    rates = {
        tr.track_id: rate
        for tr in project.transcripts
        if (rate := track_punctuation_rate(tr.words)) is not None
    }
    if len(rates) < 2:
        return []
    flags: list[dict[str, Any]] = []
    for track_id, rate in rates.items():
        peers = [r for tid, r in rates.items() if tid != track_id]
        peer_average = sum(peers) / len(peers)
        if peer_average < _PUNCTUATION_OUTLIER_MIN_PEER_RATE:
            continue
        if rate <= peer_average * _PUNCTUATION_OUTLIER_RATIO:
            flags.append(
                {
                    "track_id": track_id,
                    "punctuation_rate": round(rate, 4),
                    "peer_average_rate": round(peer_average, 4),
                    "reason": PUNCTUATION_RATE_OUTLIER_REASON,
                }
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
        # Dialogue-track levels for the aligner evidence gate (#780), decoded once per engine
        # the first time a scored transcript needs them.
        self._speech_levels: SpeechLevels | None = None

    def _get_model(self):
        if self._model is None:
            from faster_whisper import WhisperModel

            model_path = resolve_whisper_model_path(self.model_size)
            self._model = WhisperModel(
                model_path,
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

    def read_asr_cache(
        self,
        project: EpisodeProject,
        job: TranscribeJob,
        *,
        language: str | None,
        initial_prompt: str | None,
        audio_sha256: str,
    ) -> tuple[Path, Transcript | None]:
        """This job's ASR cache path and its cached words.

        The transcript is None on a miss; Whisper never runs here.
        """
        cache = self.cache_path(
            project,
            job.cache_id,
            job.audio,
            language=language,
            initial_prompt=initial_prompt,
            audio_sha256=audio_sha256,
        )
        transcript = _read_cache(cache)
        return cache, transcript

    def load_word_aligner(self) -> WordAligner:
        """Load (once per engine) the forced aligner; raises the cached load error on every later call."""
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

    def speech_levels(self, project: EpisodeProject) -> SpeechLevels:
        """The evidence gate's track levels, built once per engine (one run or request).

        Transcription runs before ``align_tracks``, so only the own-track half of the gate
        applies here; ``reconcile_transcript`` re-flags with the full gate.
        """
        if self._speech_levels is None:
            self._speech_levels = SpeechLevels.for_project(project, self.options, bleed_check=False)
        return self._speech_levels

    def _align_words(
        self,
        project: EpisodeProject,
        job: TranscribeJob,
        transcript: Transcript,
        asr_cache: Path,
        *,
        use_cache: bool,
    ) -> dict[str, Any] | None:
        """Forced alignment (on when the aligner is installed); on any failure Whisper's times
        stay and the job is reported. Returns this job's report entry, None when alignment is off.
        """
        if not self.options.forced_alignment_enabled or not transcript.words:
            return None
        from podcast_mcp.engines.ctc_forced_align import ALIGNMENT_SCORE_METHOD
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
            aligner = self.load_word_aligner()
        except Exception as exc:  # missing model / onnxruntime / corrupt snapshot
            keep_whisper("failed", str(exc))
            return entry
        if not aligner.supports_language(transcript.language):
            keep_whisper(
                "skipped",
                f"{aligner.model.id} does not support language {transcript.language!r}",
            )
            return entry
        path = self.word_align_cache_path(
            project, job.cache_id, asr_cache, aligner, transcript.words
        )
        cached = _read_align_cache(path, len(transcript.words)) if use_cache else None
        status = "cached"
        align_sec: float | None = None
        if cached is None:
            status = "aligned"
            raise_if_cancel_requested(current_cancel_check(), TRANSCRIBE_CANCELLED)
            try:
                with resolve_progress_task("forced_alignment", f"Aligning words {job.label}"):
                    result = aligner.align(job.audio, transcript.words)
            except Exception as exc:  # decode / inference failure
                keep_whisper("failed", str(exc))
                return entry
            spans = result.spans
            scores: list[float | None] = list(result.scores) or [None] * len(spans)
            align_sec = round(result.runtime_sec, 3)
            _write_align_cache(project, path, asr_cache, aligner, result)
        else:
            spans, scores = cached
        retimed = apply_word_spans(transcript.words, spans, scores)
        if not retimed:
            keep_whisper("failed", "no words aligned")
            return entry
        entry.update(
            status=status,
            aligned_words=retimed,
            unaligned_words=len(transcript.words) - retimed,
        )
        if align_sec is not None:
            entry["align_sec"] = align_sec
        transcript.word_aligner = aligner.model.id
        transcript.alignment_score_method = ALIGNMENT_SCORE_METHOD
        return entry

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
        """Transcribe one job from its input-keyed cache, otherwise run ASR.

        use_cache=False skips the cache.
        """
        sha = audio_sha256 or sha256_file(job.audio)
        transcript: Transcript | None = None
        if use_cache:
            cache, transcript = self.read_asr_cache(
                project, job, language=language, initial_prompt=initial_prompt, audio_sha256=sha
            )
        else:
            cache = self.cache_path(
                project,
                job.cache_id,
                job.audio,
                language=language,
                initial_prompt=initial_prompt,
                audio_sha256=sha,
            )
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
        transcript.alignment_score_method = None
        # Cached words carry no silence flags or alignment scores: they are recomputed
        # below from the current transcribe.silence_filter settings (not a cache input)
        # on every read, and _align_words re-derives the scores.
        for word in transcript.words:
            word.suspect_hallucination = False
            word.alignment_score = None
        if fresh:
            # Whisper's own times (transcribe_file already flagged them with this
            # max_word_sec); alignment has its own cache, so the flag never re-runs Whisper.
            with _cache_publication_lock(project, cache):
                write_text_atomic(cache, transcript.model_dump_json(indent=2))
                _prune_asr_cache(project, cache)
        align_entry = self._align_words(project, job, transcript, cache, use_cache=use_cache)
        # Backstop on the final spans (aligned, or Whisper's where alignment was off/failed).
        flag_anomalous_asr_durations(
            transcript.words, max_word_sec=max_word_sec, track_id=job.track_id
        )
        evidence = self._evidence_for(project, job, transcript)
        n = refresh_silence_flags(
            transcript.words,
            job.audio,
            self.options,
            evidence=evidence,
            track_id=job.track_id,
        )
        min_score = self.options.forced_alignment_min_word_score
        if align_entry is not None and forced_alignment_succeeded(align_entry) and min_score > 0:
            align_entry["no_evidence_words"] = sum(
                1
                for w in transcript.words
                if w.suspect_hallucination and below_evidence_floor(w.alignment_score, min_score)
            )
        if n is None:
            self.silence_filter_skipped.append(job.label)
            transcript.silence_filter_fingerprint = None
        else:
            transcript.silence_filter_fingerprint = silence_filter_fingerprint(
                transcript.words,
                sha,
                self.options,
                evidence=(
                    evidence.fingerprint_term(job.track_id) if evidence is not None else "own"
                ),
            )
        if n:
            log.info(
                "%s: %d word(s) flagged suspect_hallucination (silence or no aligner evidence)",
                job.label,
                n,
            )
        return transcript

    def _evidence_for(
        self, project: EpisodeProject, job: TranscribeJob, transcript: Transcript
    ) -> SpeechLevels | None:
        """Track levels for the evidence gate, only when a scored word could need them.

        An extra-source job (``source_id``) is not the track's primary media, so its clock
        does not match the track levels; it gets no gate and its low scores never flag.
        """
        if not evidence_applies(transcript.words, self.options, source_id=job.source_id):
            return None
        return self.speech_levels(project)

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
        utterances = [
            CombinedUtterance(
                track_id=run.track_id,
                speaker=run.speaker,
                start=run.words[0].start,
                end=run.words[-1].end,
                text=utterance_text(run.words),
            )
            for run in transcript_word_runs(project)
        ]
        return CombinedTranscript(utterances=utterances)
