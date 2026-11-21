from __future__ import annotations

import struct
import wave
from pathlib import Path

from podcast_mcp.models import Clip, MediaAsset, Track
from podcast_mcp.project.store import WriteGrantKind, write_grant
from podcast_mcp.services.app import ProjectWorkspace

EXPECTED_CLIPS_SECONDS = (
    ("Host", 0.5, 0.5, 0.25),
    ("Host", 0.875, 0.25, 0.0),
    ("Host", 1.5, 0.125, 0.0),
    ("Guest", 0.0, 2.0, 0.0),
)


def _pcm_wav(path: Path, sample_rate: int, channels: int, frames: int, seed: int) -> MediaAsset:
    with wave.open(str(path), "wb") as audio:
        audio.setparams((channels, 2, sample_rate, 0, "NONE", "not compressed"))
        samples = [
            (seed * 997 + channel * 7001 + frame % 97) % 30_000 - 15_000
            for frame in range(frames)
            for channel in range(channels)
        ]
        audio.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return MediaAsset(path=path.name)


def create_daw_export_project(
    root: Path,
    *,
    mixed_rates: bool = True,
    guest_frames: int | None = None,
    guest_sample_rate: int | None = None,
    guest_clip_frame_bounds: tuple[int, int] | None = None,
) -> ProjectWorkspace:
    with write_grant(WriteGrantKind.DISPATCHER):
        workspace = ProjectWorkspace.create(root)
    host = _pcm_wav(root / "host.wav", 48_000, 1, 96_000, 1)
    guest_rate = guest_sample_rate or (44_100 if mixed_rates else 48_000)
    guest = _pcm_wav(root / "guest.wav", guest_rate, 2, guest_frames or guest_rate * 2, 2)
    workspace.project.timeline.tracks = [
        Track(id="host", label="Host", media=host),
        Track(id="guest", label="Guest", media=guest),
        Track(id="empty", label="Empty", media=host, timeline_empty=True),
    ]
    workspace.project.timeline.clips = [
        Clip(
            id="moved",
            track_id="host",
            source_start=0.25,
            source_end=0.75,
            timeline_start=0.5,
            fade_in_ms=20,
        ),
        Clip(
            id="overlap",
            track_id="host",
            source_start=0,
            source_end=0.25,
            timeline_start=0.875,
            fade_out_ms=10,
        ),
        Clip(id="after-gap", track_id="host", source_start=0, source_end=0.125, timeline_start=1.5),
    ]
    if guest_clip_frame_bounds is not None:
        source_start, source_end = guest_clip_frame_bounds
        workspace.project.timeline.clips.append(
            Clip(
                id="guest-bounds",
                track_id="guest",
                source_start=source_start / guest_rate,
                source_end=source_end / guest_rate,
                timeline_start=0.5,
            )
        )
    with write_grant(WriteGrantKind.DISPATCHER):
        workspace.save()
    return workspace
