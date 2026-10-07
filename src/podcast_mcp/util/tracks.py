from __future__ import annotations

from pathlib import Path

from podcast_mcp.models import EpisodeProject, Track, TrackRole
from podcast_mcp.util.coded_error import CodedKeyError, CodedValueError
from podcast_mcp.util.workspace_paths import resolve_under_workspace


def unknown_track(track_id: str) -> CodedValueError:
    """The refusal for a ``track_id`` the project does not have (raise it)."""
    return CodedValueError(f"unknown track_id: {track_id!r}", code="track_not_found")


def stem_path(project: EpisodeProject, track_id: str) -> Path:
    """Canonical rendered track stem path, whether or not it exists yet."""
    return project.artifacts_dir() / "tracks" / f"{track_id}.wav"


def existing_stem_path(project: EpisodeProject, track_id: str) -> Path | None:
    """Return the rendered stem only when it exists."""
    path = stem_path(project, track_id)
    return path if path.is_file() else None


def track_audio_path(project: EpisodeProject, track_id: str) -> Path:
    """Resolve a dialogue track's raw source audio file path."""
    track = project.track_by_id(track_id)
    if not track:
        raise unknown_track(track_id)
    if not track.media:
        raise CodedValueError(f"track {track_id!r} has no media", code="track_has_no_media")
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
        raise unknown_track(track_id)

    if not speaker:
        raise CodedValueError("track_id or speaker is required", code="missing_argument")

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
        raise CodedValueError(
            f"ambiguous speaker {speaker!r}; matches: {ids}", code="ambiguous_speaker"
        )

    raise CodedValueError(
        f"no track for speaker {speaker!r}; available: "
        + ", ".join(f"{t.id} ({t.speaker or t.label})" for t in project.tracks),
        code="track_not_found",
    )


def dialogue_track_ids(project: EpisodeProject) -> list[str]:
    """Every dialogue track id, muted or not.

    A saved mute is mix state, not timeline membership: edits, analysis and
    render caches cover muted tracks so they stay in sync for an unmute.
    """
    return [t.id for t in project.tracks if t.role == TrackRole.DIALOGUE]


def mixed_dialogue_track_ids(project: EpisodeProject) -> list[str]:
    """Dialogue track ids the mix plays (the saved mute leaves a track out)."""
    return [t.id for t in project.tracks if t.role == TrackRole.DIALOGUE and not t.muted]


def recording_audio_path(project: EpisodeProject, track_id: str, source_id: str | None) -> Path:
    """Resolve exact raw recording media; None selects the track's primary media."""
    if source_id is None:
        return resolve_under_workspace(project, str(track_audio_path(project, track_id)))
    if project.track_by_id(track_id) is None:
        raise CodedKeyError(f"unknown track {track_id!r}", code="track_not_found")
    source = project.source_by_id(source_id)
    if source is None:
        raise CodedKeyError(f"unknown source recording {source_id!r}", code="source_not_found")
    return resolve_under_workspace(project, source.path)
