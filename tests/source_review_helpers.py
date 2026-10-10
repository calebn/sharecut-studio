from __future__ import annotations

import math
import wave
from array import array
from pathlib import Path

from podcast_mcp.edits.inaudible_cuts import OptimizedCutRange
from podcast_mcp.models import (
    Clip,
    EditDecision,
    EditDecisionType,
    EpisodeProject,
    MediaAsset,
    Track,
    TrackRole,
)


def finite_primary_recording(project: EpisodeProject, duration_sec: float = 6) -> None:
    rate = 16_000
    frames = int(duration_sec * rate)
    samples = array(
        "h", (int(6000 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(frames))
    )
    path = project.workspace_path() / "raw" / "host.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(samples.tobytes())
    with wave.open(str(path), "rb") as handle:
        media = MediaAsset(
            path="raw/host.wav",
            duration_sec=handle.getnframes() / handle.getframerate(),
            sample_rate=handle.getframerate(),
            channels=handle.getnchannels(),
        )
    track = project.track_by_id("host")
    if track is None:
        project.tracks.append(Track(id="host", label="Host", role=TrackRole.DIALOGUE, media=media))
    else:
        track.media = media
    project.timeline.duration_sec = media.duration_sec


def _project(tmp_path: Path) -> EpisodeProject:
    path = tmp_path / "raw" / "host.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(16_000)
        handle.writeframes(b"\0\0" * 96_000)
    project = EpisodeProject.create("source review", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=6, sample_rate=16_000, channels=1),
        )
    ]
    project.clips = [
        Clip(id="host", track_id="host", source_start=0, source_end=6, timeline_start=0)
    ]
    project.timeline.duration_sec = 6
    return project


def _cut(
    edit_id: str, start: float = 1, end: float = 2, *, reason="nl:range", **kwargs
) -> EditDecision:
    return EditDecision(
        id=edit_id,
        track_id="host",
        type=EditDecisionType.REMOVE,
        start=start,
        end=end,
        reason=reason,
        applied=False,
        boundary_mode="vocal_transcript_guided",
        **kwargs,
    )


def _hole(project: EpisodeProject) -> None:
    project.clips = [
        Clip(id="early", track_id="host", source_start=0, source_end=1.4, timeline_start=0),
        Clip(id="late", track_id="host", source_start=1.42, source_end=6, timeline_start=1.4),
    ]
    project.timeline.duration_sec = 5.98


def _exact_optimizer(_project, _track_id, start, end, **_kwargs):
    return OptimizedCutRange(
        start=start,
        end=end,
        mode="vocal_transcript_guided",
        shifted_start_ms=0,
        shifted_end_ms=0,
        confidence=1,
        details={},
    )
