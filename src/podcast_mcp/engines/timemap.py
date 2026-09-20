from __future__ import annotations

from pathlib import Path

from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.timebase import TimelineSec


class TimelineMapError(ValueError):
    pass


def _source_media_path(project: EpisodeProject, track_id: str) -> Path:
    track = project.track_by_id(track_id)
    if not track or not track.media:
        raise TimelineMapError(f"track {track_id!r} has no media")
    src = Path(track.media.path)
    if not src.is_absolute():
        src = project.workspace_path() / src
    return src


def timeline_to_source(
    project: EpisodeProject,
    track_id: str,
    timeline_sec: float,
) -> tuple[Path, float]:
    """Map a timeline second to absolute path and offset in source media.

    Positions past the last clip clamp to the end of the last clip's source
    span; positions before the first clip raise ``TimelineMapError``.
    """
    src = _source_media_path(project, track_id)
    st = SessionTimeline(project)
    mapped = st.timeline_to_source(track_id, TimelineSec(timeline_sec))
    if mapped is not None:
        return src, float(mapped)

    extent = st.timeline_extent(track_id)
    if extent is None:
        return src, timeline_sec
    timeline_end, source_end = extent
    if timeline_sec >= float(timeline_end):
        return src, float(source_end)
    raise TimelineMapError(f"timeline {timeline_sec}s is before first clip on track {track_id!r}")


def timeline_range_to_source(
    project: EpisodeProject,
    track_id: str,
    start_sec: float,
    end_sec: float,
) -> tuple[Path, float, float]:
    """Map [start, end] on timeline to source file path and source-time bounds."""
    if end_sec <= start_sec:
        raise TimelineMapError("end must be after start")
    path_start, src_start = timeline_to_source(project, track_id, start_sec)
    _, src_end = timeline_to_source(project, track_id, end_sec)
    return path_start, src_start, src_end
