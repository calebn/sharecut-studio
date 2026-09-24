from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from podcast_mcp.engines.peaks import peaks_generation_pending, schedule_track_peaks
from podcast_mcp.models import EpisodeProject

__all__ = [
    "PeaksUnavailableError",
    "TrackPeaksLookup",
    "lookup_track_peaks",
    "peaks_unavailable_body",
    "resolve_peaks_path",
]


def resolve_peaks_path(project: EpisodeProject, track_id: str) -> Path | None:
    path = project.artifacts_dir() / "peaks" / f"{track_id}.json"
    return path if path.is_file() else None


@dataclass(frozen=True)
class TrackPeaksLookup:
    """Result of looking up (and possibly scheduling) a track's overview peaks."""

    path: Path | None
    generating: bool


class PeaksUnavailableError(FileNotFoundError):
    """Raised when peaks are not on disk; ``generating`` says whether a job was queued."""

    def __init__(self, message: str = "peaks not available", *, generating: bool) -> None:
        super().__init__(message)
        self.generating = generating


def lookup_track_peaks(project: EpisodeProject, track_id: str) -> TrackPeaksLookup:
    """Resolve peaks for ``track_id``, queuing generation when missing and possible.

    The pending check runs before the file check on purpose: while a job is
    regenerating a stale sidecar (for example after ``set_track_media``), the old
    file is still on disk and must not be served as ready. ``_run_peaks_job``
    drops the pending key only after ``generate_peaks`` has renamed the new file
    into place, so a lookup that sees "not pending" also sees the finished file;
    ``schedule_track_peaks`` dedupes concurrent callers under its lock.
    """
    track = next((t for t in project.tracks if t.id == track_id), None)
    if track is None:
        return TrackPeaksLookup(path=None, generating=False)
    if peaks_generation_pending(project, track):
        return TrackPeaksLookup(path=None, generating=True)
    path = resolve_peaks_path(project, track_id)
    if path is not None:
        return TrackPeaksLookup(path=path, generating=False)
    generating = schedule_track_peaks(project, track)
    return TrackPeaksLookup(path=None, generating=generating)


def peaks_unavailable_body(track_id: str, *, generating: bool) -> dict[str, Any]:
    return {"available": False, "track_id": track_id, "generating": generating}
