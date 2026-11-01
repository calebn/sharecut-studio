"""Put a recorded take or room-tone bed on the timeline: tracks, sources and clips."""

from __future__ import annotations

from podcast_mcp.engines.clips_ops import new_clip_id
from podcast_mcp.engines.room_tone import room_tone_source_id
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    RoomToneOrigin,
    SourceClippingRegion,
    SourceRecording,
    Track,
    TrackRole,
)


def ensure_track(project: EpisodeProject, track_id: str, *, label: str) -> Track:
    track = project.track_by_id(track_id)
    if track is not None:
        return track
    track = Track(
        id=track_id,
        label=label,
        role=TrackRole.DIALOGUE,
        speaker=label,
    )
    project.tracks.append(track)
    return track


def upsert_source(
    project: EpisodeProject,
    *,
    source_id: str,
    rel: str,
    speaker: str,
    duration_s: float,
    sample_rate: int,
    channels: int,
    clipping_regions: list[SourceClippingRegion] | None = None,
    clipping_truncated: bool = False,
) -> SourceRecording:
    existing = project.source_by_id(source_id)
    if existing is not None:
        if clipping_regions is not None:
            existing.clipping_regions = list(clipping_regions)
            existing.clipping_truncated = clipping_truncated
        existing.path = rel
        existing.speaker = speaker
        existing.duration_sec = duration_s
        existing.sample_rate = sample_rate
        existing.channels = channels
        return existing
    src = SourceRecording(
        id=source_id,
        path=rel,
        speaker=speaker,
        label=source_id,
        duration_sec=duration_s,
        sample_rate=sample_rate,
        channels=channels,
        clipping_regions=list(clipping_regions or []),
        clipping_truncated=clipping_truncated,
    )
    project.sources.append(src)
    return src


def upsert_clip(
    project: EpisodeProject,
    *,
    track_id: str,
    source_id: str,
    timeline_s: float,
    duration_s: float,
) -> Clip:
    existing = next(
        (
            clip
            for clip in project.clips
            if clip.source_id == source_id and clip.track_id == track_id
        ),
        None,
    )
    if existing is not None:
        existing.source_start = 0.0
        existing.source_end = duration_s
        existing.timeline_start = timeline_s
        return existing
    clip = Clip(
        id=new_clip_id(),
        track_id=track_id,
        source_start=0.0,
        source_end=duration_s,
        timeline_start=timeline_s,
        source_id=source_id,
    )
    track = project.track_by_id(track_id)
    if track is not None:
        track.timeline_empty = False
    project.clips.append(clip)
    return clip


def place_take_clip(
    project: EpisodeProject,
    *,
    track_id: str,
    label: str,
    source_id: str,
    rel: str,
    timeline_s: float,
    duration_s: float,
    sample_rate: int,
    channels: int,
    previous_rel: str | None,
    register_source: bool = True,
    clipping_regions: list[SourceClippingRegion] | None = None,
    clipping_truncated: bool = False,
) -> Clip:
    """The track, source (unless already registered), clip and track media of one take.

    The order is part of the contract: tracks and sources append to the project lists.
    """
    ensure_track(project, track_id, label=label)
    if register_source:
        upsert_source(
            project,
            source_id=source_id,
            rel=rel,
            speaker=label,
            duration_s=duration_s,
            sample_rate=sample_rate,
            channels=channels,
            clipping_regions=clipping_regions,
            clipping_truncated=clipping_truncated,
        )
    clip = upsert_clip(
        project,
        track_id=track_id,
        source_id=source_id,
        timeline_s=timeline_s,
        duration_s=duration_s,
    )
    track = project.track_by_id(track_id)
    if track is not None and (track.media is None or track.media.path == previous_rel):
        track.media = MediaAsset(
            path=rel,
            duration_sec=duration_s,
            sample_rate=sample_rate,
            channels=channels,
        )
    return clip


def place_room_tone(
    project: EpisodeProject,
    *,
    track_id: str,
    label: str,
    rel: str,
    duration_s: float,
    sample_rate: int,
    channels: int,
) -> Track:
    """The track, its held room-tone bed and the bed's shared source."""
    track = ensure_track(project, track_id, label=label)
    # A recorded or assigned bed replaces an extracted one, and says so.
    track.room_tone_origin = None
    track.room_tone = MediaAsset(
        path=rel,
        duration_sec=duration_s,
        sample_rate=sample_rate,
        channels=channels,
    )
    upsert_source(
        project,
        source_id=room_tone_source_id(track_id),
        rel=rel,
        speaker=label,
        duration_s=duration_s,
        sample_rate=sample_rate,
        channels=channels,
    )
    return track


def place_extracted_room_tone(
    project: EpisodeProject,
    *,
    track_id: str,
    rel: str,
    duration_s: float,
    sample_rate: int,
    channels: int,
    origin: RoomToneOrigin,
) -> Track:
    """Register a bed the pipeline cut from the track's own audio, with where it came from."""
    existing = project.track_by_id(track_id)
    if existing is None:
        raise ValueError(f"no track {track_id!r} to hold an extracted room-tone bed")
    track = place_room_tone(
        project,
        track_id=track_id,
        label=existing.label,
        rel=rel,
        duration_s=duration_s,
        sample_rate=sample_rate,
        channels=channels,
    )
    track.room_tone_origin = origin
    return track
