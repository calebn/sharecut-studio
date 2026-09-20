"""Keep per-track transcripts consistent with clip edits.

Invariant: ``TranscriptWord.start/end`` are ALWAYS source-media seconds.
Edits drop words whose source material was removed; surviving words are never
shifted or remapped. Consumers that need timeline positions map through
``podcast_mcp.engines.session_timeline.SessionTimeline`` at read time.
"""

from __future__ import annotations

from podcast_mcp.edits.ranges import overlaps_remove_range
from podcast_mcp.engines.session_timeline import map_timeline_spans_over_clips
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models import Clip, EpisodeProject


def rebuild_combined(project: EpisodeProject) -> None:
    project.combined_transcript = TranscriptionEngine().merge_transcripts(project)


def apply_source_transcript_removes(
    project: EpisodeProject,
    removes_by_track: dict[str, list[tuple[float, float]]],
    *,
    rebuild: bool = True,
) -> None:
    """Drop words overlapping source-time removes; keep surviving word times unchanged."""
    if not removes_by_track:
        return
    by_id = {tr.track_id: tr for tr in project.transcripts}
    for track_id, ranges in removes_by_track.items():
        tr = by_id.get(track_id)
        if not tr or not ranges:
            continue
        sorted_removes = sorted(ranges, key=lambda r: r[0])
        tr.words = [
            w for w in tr.words if not overlaps_remove_range(w.start, w.end, sorted_removes)
        ]
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

    removes_by_track: dict[str, list[tuple[float, float]]] = {}
    track_ids = {tr.track_id for tr in project.transcripts}
    for track_id in track_ids:
        clips = (clips_before or {}).get(track_id) or clips_for_track(project, track_id)
        src_ranges = timeline_removes_to_source_ranges(clips, removes)
        if src_ranges:
            removes_by_track[track_id] = src_ranges
    apply_source_transcript_removes(project, removes_by_track, rebuild=rebuild)
