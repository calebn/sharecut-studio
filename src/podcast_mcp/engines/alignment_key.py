"""``meta.ingest_alignment`` keys: the speaker label and the per-clip key built from it."""

from __future__ import annotations

from podcast_mcp.models import Clip, Track


def speaker_label(track: Track) -> str:
    return track.speaker or track.label or track.id


def ingest_alignment_key(track: Track, clip: Clip, *, per_clip: bool) -> str:
    """``meta.ingest_alignment`` key: ``track_id:clip_id`` per clip, else the speaker label."""
    return f"{track.id}:{clip.id}" if per_clip else speaker_label(track)
