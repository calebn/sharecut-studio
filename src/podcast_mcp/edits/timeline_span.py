"""Source-clock edit/word spans mapped onto the session timeline."""

from __future__ import annotations

from collections.abc import Sequence

from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EditDecision, EditDecisionType, EpisodeProject
from podcast_mcp.util.source_spans import source_span_timeline_bounds as source_span_timeline_bounds
from podcast_mcp.util.timebase import SourceSec, TimelineSec


def timeline_span_dicts(
    spans: Sequence[tuple[TimelineSec, TimelineSec]],
) -> list[dict[str, float]]:
    """``[{"start", "end"}]`` rows for mapped timeline intervals."""
    return [{"start": float(start), "end": float(end)} for start, end in spans]


def map_source_span_fields(
    timeline: SessionTimeline,
    track_id: str,
    source_start: float,
    source_end: float,
) -> tuple[bool, list[dict[str, float]], float | None, float | None]:
    """Map a source-clock interval to timeline spans (first/last bounds)."""
    spans = timeline.map_source_span(
        track_id,
        SourceSec(source_start),
        SourceSec(source_end),
    )
    mappable = bool(spans)
    timeline_spans = timeline_span_dicts(spans)
    timeline_start = timeline_spans[0]["start"] if timeline_spans else None
    timeline_end = timeline_spans[-1]["end"] if timeline_spans else None
    return mappable, timeline_spans, timeline_start, timeline_end


def source_remove_timeline_spans(
    project: EpisodeProject, edit: EditDecision
) -> list[dict[str, float]] | None:
    """Return only the witnessed placement for a source-aware ordinary remove.

    ``None`` means the selected source no longer has exactly its staged geometry.
    This checks display geometry only; approval retains its broader scope guards.
    """
    from podcast_mcp.engines.session_timeline import clip_plays_lane
    from podcast_mcp.util.timebase import SourceSec

    if edit.type != EditDecisionType.REMOVE or edit.timebase != "source":
        return None
    timeline = SessionTimeline(project)
    lane_clips = [c for c in project.clips if clip_plays_lane(project, c, edit.track_id)]
    if lane_clips:
        transcript = project.transcript_for_source(edit.track_id, edit.source_id)
        placements = {
            c.source_id
            for c in lane_clips
            if transcript is not None
            and (
                project.transcript_for_source(edit.track_id, c.source_id) is transcript
                or (transcript is None and edit.source_id is None and c.source_id is None)
            )
        }
        spans = timeline.map_placements_source_span(
            edit.track_id, placements, SourceSec(edit.start), SourceSec(edit.end)
        )
    elif edit.source_id is None:
        spans = timeline.map_source_span(edit.track_id, SourceSec(edit.start), SourceSec(edit.end))
    else:
        spans = []
    witness = edit.source_timeline_span
    if witness is not None and (
        len(spans) != 1
        or abs(float(spans[0][1] - spans[0][0]) - (edit.end - edit.start)) > 1e-6
        or abs(float(spans[0][0]) - witness.start) > 1e-6
        or abs(float(spans[0][1]) - witness.end) > 1e-6
    ):
        return None
    if not spans:
        return None
    return timeline_span_dicts(spans)
