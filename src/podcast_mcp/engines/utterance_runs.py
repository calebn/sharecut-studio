"""Utterance grouping shared by ``merge_transcripts`` and the GUI view mapper (#758)."""

from __future__ import annotations

from collections.abc import Sequence

from podcast_mcp.models import EpisodeProject, TranscriptWord

UTTERANCE_GAP_SEC = 0.8
"""A new combined utterance starts when a word begins more than this long after the previous one ends."""


def utterance_runs(
    words: Sequence[TranscriptWord], gap_threshold: float = UTTERANCE_GAP_SEC
) -> list[range]:
    """Split ``words`` (list order) into consecutive position ranges at every gap above ``gap_threshold``.

    The ranges partition ``range(len(words))``: every position is in exactly one run.
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


def utterance_text(words: Sequence[TranscriptWord]) -> str:
    """Combined-utterance text for ``words``: their texts space-joined and stripped."""
    return " ".join(w.text for w in words).strip()
