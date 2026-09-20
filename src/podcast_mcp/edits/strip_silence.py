from __future__ import annotations

from pathlib import Path

from podcast_mcp.edits.clips_ops import (
    new_clip_id,
    set_track_clips,
    update_timeline_duration,
)
from podcast_mcp.edits.inaudible_cuts import recommend_micro_fades
from podcast_mcp.edits.ranges import merge_timeline_ranges, subtract_ranges_from_intervals
from podcast_mcp.edits.transcript_sync import apply_source_transcript_removes
from podcast_mcp.engines.silence import SilenceInterval, detect_silence
from podcast_mcp.models import Clip, ClipJoinMode, EpisodeProject


def _kept_source_ranges(
    duration: float,
    silences: list[SilenceInterval],
    keep_padding_sec: float,
) -> list[tuple[float, float]]:
    """Return speech islands after subtracting silence (padding stays as retained air).

    Padding is taken from the *interior* of each silence interval so short speech
    between nearby silences is never dropped. Silences shorter than
    ``2 * keep_padding_sec`` emit no remove and stay fully retained.
    """
    if duration <= 0:
        return []
    if not silences:
        return [(0.0, duration)]
    removes: list[tuple[float, float]] = []
    for s in silences:
        a = max(0.0, s.start + keep_padding_sec)
        b = min(duration, s.end - keep_padding_sec)
        if b > a + 1e-9:
            removes.append((a, b))
    removes = merge_timeline_ranges(removes)
    if not removes:
        return [(0.0, duration)]
    return [
        (a, b)
        for a, b in subtract_ranges_from_intervals([(0.0, duration)], removes)
        if b > a + 1e-6
    ]


def strip_silence(
    project: EpisodeProject,
    track_id: str,
    *,
    threshold_db: float = -40.0,
    min_duration_sec: float = 0.5,
    keep_padding_sec: float = 0.05,
    use_inaudible_opt: bool | None = None,
) -> dict:
    """Rebuild a track from speech islands between detected silences.

    ``use_inaudible_opt`` is accepted for API compatibility but ignored: strip
    keeps speech islands as-is (no ``optimize_source_cut_range``). Micro-fades
    still apply at rebuilt joins via ``recommend_micro_fades``.
    """
    del use_inaudible_opt
    track = project.track_by_id(track_id)
    if not track or not track.media:
        raise ValueError(f"track {track_id!r} not found or has no media")

    src = Path(track.media.path)
    if not src.is_absolute():
        src = project.workspace_path() / src

    from podcast_mcp.engines.ffmpeg import FFmpegEngine

    probe = FFmpegEngine().probe(src)
    silences = detect_silence(
        src,
        threshold_db=threshold_db,
        min_duration_sec=min_duration_sec,
    )
    kept = _kept_source_ranges(probe.duration_sec, silences, keep_padding_sec)

    timeline_cursor = 0.0
    new_clips: list[Clip] = []
    fades = recommend_micro_fades()
    for src_start, src_end in kept:
        new_clips.append(
            Clip(
                id=new_clip_id(),
                track_id=track_id,
                source_start=src_start,
                source_end=src_end,
                timeline_start=timeline_cursor,
                fade_in_ms=fades["fade_in_ms"] if timeline_cursor > 0 else 0,
                fade_out_ms=fades["fade_out_ms"],
                join_in_mode=ClipJoinMode.FADE,
            )
        )
        timeline_cursor += src_end - src_start

    set_track_clips(project, track_id, new_clips)
    update_timeline_duration(project)
    # Words stay in source coordinates; drop only those in removed source ranges.
    removed_ranges: list[tuple[float, float]] = []
    cursor = 0.0
    for src_start, src_end in kept:
        if src_start > cursor + 1e-6:
            removed_ranges.append((cursor, src_start))
        cursor = max(cursor, src_end)
    if cursor < probe.duration_sec - 1e-6:
        removed_ranges.append((cursor, probe.duration_sec))
    apply_source_transcript_removes(project, {track_id: removed_ranges})

    removed_sec = probe.duration_sec - sum(e - s for s, e in kept)
    return {
        "track_id": track_id,
        "silence_intervals": len(silences),
        "clips_created": len(new_clips),
        "removed_sec": removed_sec,
        "timeline_duration_sec": project.timeline.duration_sec,
    }
