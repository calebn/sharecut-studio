from __future__ import annotations

from pathlib import Path

from podcast_mcp.models import EpisodeProject


def resolve_peaks_path(project: EpisodeProject, track_id: str) -> Path | None:
    path = project.artifacts_dir() / "peaks" / f"{track_id}.json"
    return path if path.is_file() else None
