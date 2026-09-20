from __future__ import annotations

from typing import Any

from podcast_mcp.models import EpisodeProject


def change_summary(
    project: EpisodeProject,
    *,
    operation: str,
    affected_tracks: list[str],
    **params: Any,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "operation": operation,
        "affected_tracks": affected_tracks,
        "clip_count": len(project.clips),
        "timeline_duration_sec": project.timeline.duration_sec,
    }
    out.update(params)
    return out
