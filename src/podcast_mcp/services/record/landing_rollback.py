"""Undo project registration for a landed item whose ACK generation went stale.

``RecordLandingService`` copies ACK'd bytes into ``raw/`` and only then registers
them in the project JSON. The upload row (``sync.db``) shares no transaction with
the project commit, and landing may run in a different process from GUI ingest,
so a re-ACK or a revoke can change the row in between. ``capture_prior`` snapshots
what the mutation is about to overwrite; ``revert_registration`` restores it once
landing learns, after the commit, that the row it registered is stale (#366).
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, SourceRecording


@dataclass(frozen=True)
class PriorRegistration:
    """What ``project`` held for ``(track_id, source_id)`` just before registering *rel*."""

    track_id: str
    source_id: str
    rel: str
    room_tone: bool
    track_existed: bool
    source: SourceRecording | None
    clip: Clip | None
    media: MediaAsset | None


def capture_prior(
    project: EpisodeProject,
    *,
    track_id: str,
    source_id: str,
    rel: str,
    room_tone: bool,
) -> PriorRegistration:
    """Deep-copy the state landing is about to overwrite, before it does."""
    track = project.track_by_id(track_id)
    source = project.source_by_id(source_id)
    clip: Clip | None = None
    if not room_tone:
        clip = next(
            (c for c in project.clips if c.source_id == source_id and c.track_id == track_id),
            None,
        )
    media: MediaAsset | None = None
    if track is not None:
        media = track.room_tone if room_tone else track.media
    return PriorRegistration(
        track_id=track_id,
        source_id=source_id,
        rel=rel,
        room_tone=room_tone,
        track_existed=track is not None,
        source=source.model_copy(deep=True) if source is not None else None,
        clip=clip.model_copy(deep=True) if clip is not None else None,
        media=media.model_copy(deep=True) if media is not None else None,
    )


def prior_to_json(prior: PriorRegistration) -> str:
    """Serialize *prior* so a failed rollback can be retried after a restart."""
    return json.dumps(
        {
            "track_id": prior.track_id,
            "source_id": prior.source_id,
            "rel": prior.rel,
            "room_tone": prior.room_tone,
            "track_existed": prior.track_existed,
            "source": prior.source.model_dump(mode="json") if prior.source else None,
            "clip": prior.clip.model_dump(mode="json") if prior.clip else None,
            "media": prior.media.model_dump(mode="json") if prior.media else None,
        }
    )


def prior_from_json(raw: str) -> PriorRegistration:
    """Inverse of :func:`prior_to_json`; raises ``ValueError`` on unreadable input."""
    try:
        data = json.loads(raw)
        source = data["source"]
        clip = data["clip"]
        media = data["media"]
        return PriorRegistration(
            track_id=str(data["track_id"]),
            source_id=str(data["source_id"]),
            rel=str(data["rel"]),
            room_tone=bool(data["room_tone"]),
            track_existed=bool(data["track_existed"]),
            source=SourceRecording.model_validate(source) if source is not None else None,
            clip=Clip.model_validate(clip) if clip is not None else None,
            media=MediaAsset.model_validate(media) if media is not None else None,
        )
    except (KeyError, TypeError, AttributeError) as exc:
        raise ValueError(f"unreadable prior registration: {exc}") from exc


def registration_present(project: EpisodeProject, prior: PriorRegistration) -> bool:
    """True while ``project`` still registers *prior*'s stale raw path for its source."""
    current = project.source_by_id(prior.source_id)
    return current is not None and current.path == prior.rel


def media_from_remaining_clip(
    project: EpisodeProject,
    track_id: str,
    *,
    skip_source_ids: frozenset[str] | set[str] = frozenset(),
) -> MediaAsset | None:
    """The earliest remaining clip's source, as a track-level ``MediaAsset`` fallback.

    Clips whose source is in *skip_source_ids* (stale keeper registrations) are ignored.
    """
    remaining = sorted(
        (clip for clip in project.clips if clip.track_id == track_id),
        key=lambda clip: clip.timeline_start,
    )
    for clip in remaining:
        if clip.source_id is None or clip.source_id in skip_source_ids:
            continue
        src = project.source_by_id(clip.source_id)
        if src is not None:
            return MediaAsset(
                path=src.path,
                duration_sec=src.duration_sec,
                sample_rate=src.sample_rate,
                channels=src.channels,
            )
    return None


def revert_registration(project: EpisodeProject, prior: PriorRegistration) -> bool:
    """Undo the registration landing made for *prior*, if nothing else built on it.

    A no-op (returns False) unless ``project.sources[prior.source_id]`` still points
    at ``prior.rel`` — the raw path the stale copy overwrote. That path check tells
    generations apart only for per-segment sources (``unique_raw_path``); room-tone
    beds reuse a fixed ``raw/room-tone/{pid}.wav``, so the caller must first confirm
    the on-disk bed still holds the stale bytes (``RecordLandingService._rollback_stale``
    does). Raw files are never deleted here; history references them.
    """
    if not registration_present(project, prior):
        return False

    prior_source = prior.source
    prior_media = prior.media
    if prior.room_tone:
        # A room-tone bed's prior registration reuses the same raw path (it's
        # fixed per participant), so the stale copy already overwrote it in
        # place. There is nothing distinct left to restore it to.
        if prior_source is not None and prior_source.path == prior.rel:
            prior_source = None
        if prior_media is not None and prior_media.path == prior.rel:
            prior_media = None

    if prior_source is None:
        project.sources = [src for src in project.sources if src.id != prior.source_id]
    else:
        idx = next((i for i, src in enumerate(project.sources) if src.id == prior.source_id), None)
        if idx is not None:
            project.sources[idx] = prior_source.model_copy(deep=True)

    track = project.track_by_id(prior.track_id)
    if track is None:
        return True

    if not prior.room_tone:
        existing_idx = next(
            (
                i
                for i, clip in enumerate(project.clips)
                if clip.source_id == prior.source_id and clip.track_id == prior.track_id
            ),
            None,
        )
        if prior.clip is None:
            if existing_idx is not None:
                del project.clips[existing_idx]
        else:
            restored_clip = prior.clip.model_copy(deep=True)
            if existing_idx is not None:
                project.clips[existing_idx] = restored_clip
            else:
                project.clips.append(restored_clip)

    if prior.room_tone:
        if track.room_tone is not None and track.room_tone.path == prior.rel:
            track.room_tone = prior_media
    else:
        if track.media is not None and track.media.path == prior.rel:
            track.media = prior_media
            if track.media is None:
                track.media = media_from_remaining_clip(project, prior.track_id)

    if (
        not prior.track_existed
        and not any(clip.track_id == prior.track_id for clip in project.clips)
        and track.room_tone is None
    ):
        project.tracks = [t for t in project.tracks if t.id != prior.track_id]

    return True
