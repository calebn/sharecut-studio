"""Transcript text search and the timeline span each match maps to (below the cut writers)."""

from __future__ import annotations

from dataclasses import dataclass

from podcast_mcp.config.defaults import EffectiveConfig
from podcast_mcp.engines import TranscriptionEngine
from podcast_mcp.engines.session_timeline import SessionTimeline, clip_plays_lane
from podcast_mcp.models import (
    CombinedTranscript,
    EpisodeProject,
)
from podcast_mcp.util.text import normalize_text
from podcast_mcp.util.timebase import SourceSec


@dataclass
class TranscriptMatch:
    track_id: str
    source_id: str | None
    start: float
    end: float
    text: str
    speaker: str | None = None
    utterance_index: int | None = None
    word_start_index: int | None = None
    word_end_index: int | None = None
    timeline_start: float | None = None
    timeline_end: float | None = None


def timeline_span_for_source(
    project: EpisodeProject,
    track_id: str,
    source_id: str | None,
    src_start: float,
    src_end: float,
) -> tuple[float | None, float | None]:
    timeline = SessionTimeline(project)
    lane_clips = [c for c in project.clips if clip_plays_lane(project, c, track_id)]
    selected_source_ids = project.equivalent_source_ids(track_id, source_id)
    if not lane_clips and None in selected_source_ids:
        spans = timeline.map_source_span(track_id, SourceSec(src_start), SourceSec(src_end))
    else:
        spans = timeline.map_placements_source_span(
            track_id, selected_source_ids, SourceSec(src_start), SourceSec(src_end)
        )
    return (float(spans[0][0]), float(spans[-1][1])) if spans else (None, None)


def _with_timeline_spans(project: EpisodeProject, match: TranscriptMatch) -> TranscriptMatch:
    tl_start, tl_end = timeline_span_for_source(
        project, match.track_id, match.source_id, match.start, match.end
    )
    if match.timeline_start is None:
        match.timeline_start = tl_start
    if match.timeline_end is None:
        match.timeline_end = tl_end
    return match


def ensure_combined_transcript(
    project: EpisodeProject, *, defaults: EffectiveConfig
) -> CombinedTranscript:
    if project.transcripts:
        project.combined_transcript = TranscriptionEngine(defaults=defaults).merge_transcripts(
            project
        )
        return project.combined_transcript
    if project.combined_transcript is not None:
        return project.combined_transcript

    project.combined_transcript = TranscriptionEngine(defaults=defaults).merge_transcripts(project)
    return project.combined_transcript


def search_transcript(
    project: EpisodeProject,
    query: str,
    *,
    track_id: str | None = None,
    speaker: str | None = None,
    fuzzy: bool = True,
    include_suppressed: bool = False,
    defaults: EffectiveConfig,
) -> list[TranscriptMatch]:
    q = normalize_text(query)
    if not q:
        return []
    matches: list[TranscriptMatch] = []
    combined = ensure_combined_transcript(project, defaults=defaults)
    for idx, utt in enumerate(combined.utterances):
        if track_id and utt.track_id != track_id:
            continue
        if speaker and normalize_text(utt.speaker) != normalize_text(speaker):
            continue
        hay = normalize_text(utt.text) if fuzzy else utt.text
        if q in hay:
            matches.append(
                _with_timeline_spans(
                    project,
                    TranscriptMatch(
                        track_id=utt.track_id,
                        source_id=utt.source_id,
                        start=utt.start,
                        end=utt.end,
                        text=utt.text,
                        speaker=utt.speaker,
                        utterance_index=idx,
                    ),
                )
            )

    for transcript in project.transcripts:
        if track_id and transcript.track_id != track_id:
            continue
        words = transcript.words
        if not words:
            continue
        tr = project.track_by_id(transcript.track_id)
        sp = tr.speaker if tr else transcript.track_id
        if speaker and sp and normalize_text(sp) != normalize_text(speaker):
            continue
        window = 16
        for i in range(len(words)):
            if not include_suppressed and words[i].suppressed:
                continue
            for j in range(i, min(len(words), i + window)):
                if not include_suppressed and any(w.suppressed for w in words[i : j + 1]):
                    continue
                chunk = " ".join(w.text for w in words[i : j + 1])
                hay = normalize_text(chunk) if fuzzy else chunk
                if q in hay:
                    matches.append(
                        _with_timeline_spans(
                            project,
                            TranscriptMatch(
                                track_id=transcript.track_id,
                                source_id=transcript.source_id,
                                start=words[i].start,
                                end=words[j].end,
                                text=chunk,
                                speaker=sp,
                                word_start_index=i,
                                word_end_index=j,
                            ),
                        )
                    )
                    break
            else:
                continue
            break
    return matches
