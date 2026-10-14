"""Utterance grouping shared by ``merge_transcripts`` and the GUI view mapper (#758)."""

from __future__ import annotations

from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass, field

from podcast_mcp.models import EpisodeProject, TranscriptWord

UTTERANCE_GAP_SEC = 0.8
"""A new combined utterance starts when a word begins more than this long after the previous one ends."""


def utterance_runs(
    words: Sequence[TranscriptWord], gap_threshold: float = UTTERANCE_GAP_SEC
) -> list[range]:
    """Split ``words`` (list order) into consecutive position ranges at every gap above ``gap_threshold``.

    Precondition: ``words`` is in ascending ``start`` order (``Transcript.words`` is
    chronological). Gaps are measured between list neighbours, and unsorted input is
    not detected. The ranges partition ``range(len(words))``: every position is in
    exactly one run.
    """
    runs: list[range] = []
    start = 0
    for position in range(1, len(words)):
        if words[position].start - words[position - 1].end > gap_threshold:
            runs.append(range(start, position))
            start = position
    if words:
        runs.append(range(start, len(words)))
    return runs


def utterance_speaker(project: EpisodeProject, track_id: str) -> str:
    """Speaker label a combined utterance on ``track_id`` carries (track speaker, else the track id)."""
    track = project.track_by_id(track_id)
    return (track.speaker if track else None) or track_id


def lane_has_recording_clips(project: EpisodeProject, track_id: str, source_id: str | None) -> bool:
    return any(clip.track_id == track_id and clip.source_id == source_id for clip in project.clips)


def utterance_text(words: Sequence[TranscriptWord]) -> str:
    """Combined-utterance text for ``words``: their texts space-joined and stripped."""
    return " ".join(w.text for w in words).strip()


@dataclass(frozen=True)
class TranscriptWordRun:
    """One kept-word (non-suppressed) run: a combined utterance's track, speaker, and words."""

    track_id: str
    speaker: str
    words: tuple[TranscriptWord, ...]
    source_id: str | None = None
    """The transcript's ``source_id``: which take on the lane the words come from."""


def transcript_word_runs(project: EpisodeProject) -> list[TranscriptWordRun]:
    """Kept-word runs across every track transcript, sorted by first word start.

    The grouping ``merge_transcripts`` (combined-utterance text) and caption export
    (word-timed cue splitting) both need: per track, drop suppressed words, split into
    runs at ``utterance_runs`` gaps, sort the runs across tracks by start. Each caller
    projects the words differently, so the words themselves stay in the result.
    """
    out: list[TranscriptWordRun] = []
    for transcript in project.transcripts:
        if not transcript.words:
            continue
        speaker = utterance_speaker(project, transcript.track_id)
        kept = [word for word in transcript.words if not word.suppressed]
        for run in utterance_runs(kept):
            out.append(
                TranscriptWordRun(
                    track_id=transcript.track_id,
                    speaker=speaker,
                    words=tuple(kept[run.start : run.stop]),
                    source_id=transcript.source_id,
                )
            )
    out.sort(key=lambda r: r.words[0].start)
    return out


def _utterance_run_source_key(
    track_id: str, start: float, end: float, text: str
) -> tuple[str, float, float, str]:
    return track_id, float(start), float(end), str(text)


@dataclass
class UtteranceRunSourceMatcher:
    _queues: dict[tuple[str, float, float, str], deque[str | None]] = field(default_factory=dict)

    @classmethod
    def for_project(cls, project: EpisodeProject) -> UtteranceRunSourceMatcher:
        queues: dict[tuple[str, float, float, str], deque[str | None]] = {}
        for run in transcript_word_runs(project):
            key = _utterance_run_source_key(
                run.track_id,
                run.words[0].start,
                run.words[-1].end,
                utterance_text(run.words),
            )
            queues.setdefault(key, deque()).append(run.source_id)
        return cls(_queues=queues)

    def try_source_id_for(
        self, track_id: str, start: float, end: float, text: str
    ) -> tuple[bool, str | None]:
        key = _utterance_run_source_key(track_id, start, end, text)
        queue = self._queues.get(key)
        if not queue:
            return False, None
        return True, queue.popleft()
