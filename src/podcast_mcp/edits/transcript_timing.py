"""Exact-recording word timing policy; stored bounds use the source clock."""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass
from typing import Any

from podcast_mcp.edits.transcript_sync import rebuild_combined
from podcast_mcp.models import EpisodeProject, Transcript, TranscriptWord
from podcast_mcp.util.coded_error import CodedError


class TranscriptTimingChangedError(CodedError, ValueError):
    """The source word or its editing context changed before Apply."""

    code = "transcript_timing_changed"


@dataclass(frozen=True)
class WordTimingTarget:
    track_id: str
    source_id: str | None
    word_index: int


@dataclass(frozen=True)
class WordTimingMedia:
    ref: str
    duration_sec: float | None
    sample_rate: int | None
    cache_key: str
    identity: tuple[object, ...]

    def view(self) -> dict[str, Any]:
        return {
            "ref": self.ref,
            "duration_sec": self.duration_sec,
            "sample_rate": self.sample_rate,
            "cache_key": self.cache_key,
        }


def timing_transcript(project: EpisodeProject, target: WordTimingTarget) -> Transcript:
    matches = [t for t in project.transcripts if t.key == (target.track_id, target.source_id)]
    if len(matches) != 1 or not 0 <= target.word_index < len(matches[0].words):
        raise TranscriptTimingChangedError("This source word changed. Reopen Adjust timing.")
    return matches[0]


def timing_token(transcript: Transcript, target: WordTimingTarget, media: WordTimingMedia) -> str:
    body = {
        "target": asdict(target),
        "words": [w.model_dump(mode="json") for w in transcript.words],
        "media": asdict(media),
    }
    return hashlib.sha256(json.dumps(body, sort_keys=True, allow_nan=False).encode()).hexdigest()


def timing_warnings(words: list[TranscriptWord], index: int, start: float, end: float) -> list[str]:
    warnings: list[str] = []
    if index and start < words[index - 1].end:
        warnings.append("This word overlaps the previous word.")
    if index + 1 < len(words) and end > words[index + 1].start:
        warnings.append("This word overlaps the next word.")
    return warnings


def word_timing_context(
    project: EpisodeProject, target: WordTimingTarget, media: WordTimingMedia
) -> dict[str, Any]:
    transcript = timing_transcript(project, target)
    word = transcript.words[target.word_index]
    start = max(0.0, min(word.start, word.end) - 1.0)
    end = max(start + 1.0, word.start, word.end) + 1.0
    if media.duration_sec is not None:
        end = min(end, media.duration_sec)
        start = min(start, max(0.0, end - 1.0))
    track = project.track_by_id(target.track_id)
    return {
        "target": asdict(target),
        "expected_token": timing_token(transcript, target, media),
        "word": word.model_dump(mode="json"),
        "neighbors": [
            {"word_index": i, "text": w.text, "start": w.start, "end": w.end}
            for i, w in enumerate(
                transcript.words[max(0, target.word_index - 3) : target.word_index + 4],
                start=max(0, target.word_index - 3),
            )
        ],
        "media": media.view(),
        "window": {"start": start, "end": end},
        "warnings": timing_warnings(transcript.words, target.word_index, word.start, word.end),
        "transcript_gate": bool(track and track.transcript_gate),
    }


def validate_word_timing(
    project: EpisodeProject,
    target: WordTimingTarget,
    media: WordTimingMedia,
    expected_token: str,
    start: float,
    end: float,
) -> bool:
    transcript = timing_transcript(project, target)
    if timing_token(transcript, target, media) != expected_token:
        raise TranscriptTimingChangedError(
            "The transcript or recording changed. Reopen Adjust timing before saving."
        )
    if not math.isfinite(start) or not math.isfinite(end):
        raise ValueError("Word times must be finite source seconds.")
    if media.duration_sec is None:
        raise ValueError(
            "Recording duration is unavailable. Wait for its waveform, then reopen Adjust timing."
        )
    minimum = 1 / media.sample_rate if media.sample_rate else 1e-6
    if start < 0 or end > media.duration_sec or end - start < minimum - 1e-12:
        raise ValueError("Word timing must have a positive span within this recording.")
    word = transcript.words[target.word_index]
    return word.start != start or word.end != end


def apply_word_timing(
    project: EpisodeProject, target: WordTimingTarget, start: float, end: float
) -> None:
    transcript = timing_transcript(project, target)
    word = transcript.words[target.word_index]
    fields: dict[str, Any] = {
        "alignment_score": None,
        "suspect_hallucination": False,
    }
    if not word.audibility_locked and not word.ignored:
        fields.update(
            suppressed=False,
            audibility_status=None,
            dominant_track=None,
            speaker_match_track=None,
            speaker_match_score=None,
        )
    edited = word.model_copy(update=fields)
    edited.retime(start, end, by_person=True)
    transcript.words[target.word_index] = edited
    transcript.silence_filter_fingerprint = None
    transcript.user_edited = True
    rebuild_combined(project)
