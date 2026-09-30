"""Keep per-track transcripts consistent with clip edits.

Invariant: ``TranscriptWord.start/end`` are ALWAYS source-media seconds.
Edits archive words whose source material was removed; surviving words are never
shifted or remapped. Consumers that need timeline positions map through
``podcast_mcp.engines.session_timeline.SessionTimeline`` at read time.
"""

from __future__ import annotations

from podcast_mcp.edits.ranges import overlaps_remove_range
from podcast_mcp.engines.session_timeline import (
    clip_timeline_overlap_to_source,
    map_timeline_spans_over_clips,
    word_source_span,
)
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models import ArchivedTranscriptWord, Clip, EpisodeProject, TranscriptKey
from podcast_mcp.util.intervals import merge_intervals


def rebuild_combined(project: EpisodeProject) -> None:
    project.combined_transcript = TranscriptionEngine().merge_transcripts(project)


def apply_source_transcript_removes(
    project: EpisodeProject,
    removes_by_track: dict[str, list[tuple[float, float]]]
    | dict[TranscriptKey, list[tuple[float, float]]],
    *,
    rebuild: bool = True,
) -> None:
    """Archive words overlapping source-time removes; keep surviving times unchanged."""
    if not removes_by_track:
        return
    for key, ranges in removes_by_track.items():
        track_id, source_id = (key, None) if isinstance(key, str) else key
        tr = project.transcript_for_source(track_id, source_id)
        if not tr or not ranges:
            continue
        sorted_removes = sorted(ranges, key=lambda r: r[0])
        archived_ordinals = {entry.ordinal for entry in tr.archived_words}
        ordinal = 0
        kept = []
        for word in tr.words:
            while ordinal in archived_ordinals:
                ordinal += 1
            if overlaps_remove_range(word.start, word.end, sorted_removes):
                tr.archived_words.append(ArchivedTranscriptWord(ordinal=ordinal, word=word))
            else:
                kept.append(word)
            ordinal += 1
        tr.words = kept
    if rebuild:
        rebuild_combined(project)


def timeline_removes_to_source_ranges(
    clips: list[Clip],
    timeline_removes: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Map session timeline remove ranges to source-media ranges for one track."""
    if not clips:
        return []
    return [(float(s), float(e)) for s, e in map_timeline_spans_over_clips(clips, timeline_removes)]


def timeline_removes_by_transcript(
    project: EpisodeProject,
    clips: list[Clip],
    timeline_removes: list[tuple[float, float]],
) -> dict[TranscriptKey, list[tuple[float, float]]]:
    """Map removed clip material to the transcript for each recording."""
    ranges: dict[TranscriptKey, list[tuple[float, float]]] = {}
    for clip in clips:
        transcript = project.transcript_for_source(clip.track_id, clip.source_id)
        if transcript is None:
            continue
        key = (transcript.track_id, transcript.source_id)
        for start, end in timeline_removes:
            source = clip_timeline_overlap_to_source(clip, start, end)
            if source is not None:
                ranges.setdefault(key, []).append(source)
    return ranges


def restore_archived_words(project: EpisodeProject, track_ids: set[str]) -> None:
    """Restore archived words only when their entire source span is present again."""
    for transcript in project.transcripts:
        if transcript.track_id not in track_ids or not transcript.archived_words:
            continue
        coverage = merge_intervals(
            [
                (clip.source_start, clip.source_end)
                for clip in project.clips
                if clip.track_id == transcript.track_id
                and project.transcript_for_source(clip.track_id, clip.source_id) is transcript
            ],
            gap=1e-9,
        )
        restored: list[ArchivedTranscriptWord] = []
        remaining: list[ArchivedTranscriptWord] = []
        for archived in transcript.archived_words:
            word = archived.word
            word_start, word_end = word_source_span(word.start, word.end)
            if any(
                start <= word_start + 1e-9 and end >= word_end - 1e-9 for start, end in coverage
            ):
                restored.append(archived)
            else:
                remaining.append(archived)
        if restored:
            occupied = {entry.ordinal for entry in transcript.archived_words}
            active_with_order = []
            ordinal = 0
            for word in transcript.words:
                while ordinal in occupied:
                    ordinal += 1
                active_with_order.append((ordinal, word))
                ordinal += 1
            transcript.words = [
                word
                for _, word in sorted(
                    [*active_with_order, *((entry.ordinal, entry.word) for entry in restored)],
                    key=lambda item: (item[1].start, item[0]),
                )
            ]
            transcript.archived_words = remaining


def apply_batch_transcript_removes(
    project: EpisodeProject,
    removes: list[tuple[float, float]],
    *,
    rebuild: bool = True,
    clips_before: dict[str, list[Clip]] | None = None,
) -> None:
    """Drop words removed from the timeline; word times stay in source media coordinates."""
    if not removes:
        return
    from podcast_mcp.edits.clips_ops import clips_for_track

    removes_by_track: dict[TranscriptKey, list[tuple[float, float]]] = {}
    track_ids = {tr.track_id for tr in project.transcripts}
    for track_id in track_ids:
        clips = (clips_before or {}).get(track_id) or clips_for_track(project, track_id)
        for key, ranges in timeline_removes_by_transcript(project, clips, removes).items():
            removes_by_track.setdefault(key, []).extend(ranges)
    apply_source_transcript_removes(project, removes_by_track, rebuild=rebuild)
