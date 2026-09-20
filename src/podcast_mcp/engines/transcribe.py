from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from podcast_mcp.config import whisper_cache_dir
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
    TranscriptWord,
)
from podcast_mcp.util.progress import ProgressReporter, resolve_progress_task
from podcast_mcp.util.workspace_paths import resolve_under_workspace
from podcast_mcp.whisper_models import (
    DEFAULT_WHISPER_MODEL,
    ensure_whisper_model_cached,
    validate_whisper_model,
)


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def _cache_id_part(raw: str) -> str:
    if re.fullmatch(r"[A-Za-z0-9_-]+", raw):
        return raw
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


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
    def __init__(self, model_size: str = DEFAULT_WHISPER_MODEL, device: str = "cpu") -> None:
        self.model_size = validate_whisper_model(model_size)
        self.device = device
        self._model = None

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

    def cache_path(self, project: EpisodeProject, track_id: str, audio_path: Path) -> Path:
        key = _file_hash(audio_path)
        name = f"{_cache_id_part(track_id)}_{key}.json"
        cache = (project.transcripts_dir() / name).resolve()
        root = project.transcripts_dir().resolve()
        if not cache.is_relative_to(root):
            raise ValueError(f"transcript cache escaped transcripts dir: {track_id}")
        return cache

    def transcribe_file(
        self,
        audio_path: Path,
        language: str | None = "en",
        *,
        initial_prompt: str | None = None,
        max_word_sec: float = DEFAULT_MAX_WORD_DURATION_SEC,
    ) -> Transcript:
        model = self._get_model()
        kwargs: dict = {
            "language": language,
            "word_timestamps": True,
        }
        if initial_prompt:
            kwargs["initial_prompt"] = initial_prompt
        segments, _ = model.transcribe(str(audio_path), **kwargs)
        words: list[TranscriptWord] = []
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
        flag_anomalous_asr_durations(words, max_word_sec=max_word_sec)
        return Transcript(track_id="", language=language or "en", words=words)

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
        track = project.track_by_id(track_id)
        if not track or not track.media:
            raise ValueError(f"track {track_id} not found or has no media")
        audio = resolve_under_workspace(project, track.media.path)
        cache = self.cache_path(project, track_id, audio)
        if use_cache and cache.is_file():
            data = json.loads(cache.read_text(encoding="utf-8"))
            t = Transcript.model_validate(data)
            t.track_id = track_id
            # Re-flag on cache load so older caches still get deferred marks.
            flag_anomalous_asr_durations(
                t.words,
                max_word_sec=max_word_sec,
                track_id=track_id,
            )
            return t

        defaults_lang = language
        transcript = self.transcribe_file(
            audio,
            language=defaults_lang,
            initial_prompt=initial_prompt,
            max_word_sec=max_word_sec,
        )
        transcript.track_id = track_id
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(transcript.model_dump_json(indent=2), encoding="utf-8")
        return transcript

    def transcribe_all_dialogue(
        self,
        project: EpisodeProject,
        language: str | None = None,
        *,
        initial_prompt: str | None = None,
        progress: ProgressReporter | None = None,
        max_word_sec: float = DEFAULT_MAX_WORD_DURATION_SEC,
    ) -> list[Transcript]:
        dialogue = [t for t in project.tracks if t.role == TrackRole.DIALOGUE and t.media]
        # Extra whole-file sources on dialogue tracks (source_id clips).
        extra_jobs: list[tuple[str, str, Path]] = []
        for track in dialogue:
            media = track.media
            if media is None:
                continue
            clips = [c for c in project.clips if c.track_id == track.id and c.source_id]
            primary = resolve_under_workspace(project, media.path)
            for clip in clips:
                source_id = clip.source_id
                if not source_id:
                    continue
                src = next((s for s in project.sources if s.id == source_id), None)
                if src is None:
                    continue
                path = resolve_under_workspace(project, src.path)
                if path == primary:
                    continue
                if path.is_file():
                    extra_jobs.append((track.id, source_id, path))

        total = max(len(dialogue) + len(extra_jobs), 1)
        results: list[Transcript] = []
        with resolve_progress_task(
            "transcribe",
            "Transcribing tracks",
            total=total,
            prefer_parent=True,
            progress=progress,
        ) as task:
            for track in dialogue:
                task.set_phase("track", f"Track {track.id}")
                t = self.transcribe_track(
                    project,
                    track.id,
                    language=language,
                    initial_prompt=initial_prompt,
                    max_word_sec=max_word_sec,
                )
                results.append(t)
                task.advance(1, message=f"Track {track.id}", total=total)

            for track_id, source_id, audio in extra_jobs:
                task.set_phase("source", f"Track {track_id} source {source_id}")
                cache = self.cache_path(project, f"{track_id}__{source_id}", audio)
                if cache.is_file():
                    data = json.loads(cache.read_text(encoding="utf-8"))
                    t = Transcript.model_validate(data)
                else:
                    t = self.transcribe_file(
                        audio,
                        language=language,
                        initial_prompt=initial_prompt,
                        max_word_sec=max_word_sec,
                    )
                    cache.parent.mkdir(parents=True, exist_ok=True)
                    cache.write_text(t.model_dump_json(indent=2), encoding="utf-8")
                t.track_id = track_id
                t.source_id = source_id
                flag_anomalous_asr_durations(
                    t.words,
                    max_word_sec=max_word_sec,
                    track_id=track_id,
                )
                results.append(t)
                task.advance(
                    1,
                    message=f"Track {track_id} source {source_id}",
                    total=total,
                )

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
