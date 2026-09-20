from __future__ import annotations

from pathlib import Path

from podcast_mcp.models import EpisodeProject, Track, TrackRole


def track_audio_path(project: EpisodeProject, track_id: str) -> Path:
    """Resolve a dialogue track's raw source audio file path."""
    track = project.track_by_id(track_id)
    if not track or not track.media:
        raise ValueError(f"track {track_id!r} not found or has no media")
    src = Path(track.media.path)
    if not src.is_absolute():
        src = project.workspace_path() / src
    return src


def resolve_track(
    project: EpisodeProject,
    *,
    track_id: str | None = None,
    speaker: str | None = None,
) -> str:
    """Resolve track_id from explicit id or speaker/label alias."""
    if track_id:
        if project.track_by_id(track_id):
            return track_id
        raise ValueError(f"unknown track_id: {track_id!r}")

    if not speaker:
        raise ValueError("track_id or speaker is required")

    key = speaker.strip().lower()
    matches: list[Track] = []
    for t in project.tracks:
        if (
            (t.speaker and t.speaker.strip().lower() == key)
            or t.label.strip().lower() == key
            or key in t.id.lower()
        ):
            matches.append(t)

    if len(matches) == 1:
        return matches[0].id
    if len(matches) > 1:
        ids = ", ".join(t.id for t in matches)
        raise ValueError(f"ambiguous speaker {speaker!r}; matches: {ids}")

    raise ValueError(
        f"no track for speaker {speaker!r}; available: "
        + ", ".join(f"{t.id} ({t.speaker or t.label})" for t in project.tracks)
    )


def dialogue_track_ids(project: EpisodeProject, *, include_muted: bool = False) -> list[str]:
    """Dialogue track ids. Mix/render omit muted tracks; set include_muted for captions."""
    return [
        t.id
        for t in project.tracks
        if t.role == TrackRole.DIALOGUE and (include_muted or not t.muted)
    ]
