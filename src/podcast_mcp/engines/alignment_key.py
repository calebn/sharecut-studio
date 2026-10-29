"""``meta.ingest_alignment`` keys: the speaker label and the per-clip key built from it."""

from __future__ import annotations

from podcast_mcp.models import Clip, EpisodeProject, SpeakerIngestAlignment, Track, TrackRole


def speaker_label(track: Track) -> str:
    return track.speaker or track.label or track.id


def ingest_alignment_key(track: Track, clip: Clip, *, per_clip: bool) -> str:
    """``meta.ingest_alignment`` key: ``track_id:clip_id`` per clip, else the speaker label."""
    return f"{track.id}:{clip.id}" if per_clip else speaker_label(track)


def speaker_key_unique(project: EpisodeProject, track: Track) -> bool:
    """True when no other dialogue track shares this track's speaker label."""
    label = speaker_label(track)
    return (
        sum(1 for t in project.tracks if t.role == TrackRole.DIALOGUE and speaker_label(t) == label)
        == 1
    )


def ingest_alignment_entry(
    project: EpisodeProject, track: Track, clip: Clip
) -> SpeakerIngestAlignment | None:
    """This clip's ``meta.ingest_alignment`` entry: its own key, else a unique speaker key."""
    meta = project.meta.ingest_alignment or {}
    entry = meta.get(ingest_alignment_key(track, clip, per_clip=True))
    if entry is None and speaker_key_unique(project, track):
        entry = meta.get(ingest_alignment_key(track, clip, per_clip=False))
    return entry
