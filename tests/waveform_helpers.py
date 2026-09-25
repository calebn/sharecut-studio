"""Shared builders for the waveform service and route tests."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    SourceRecording,
    Track,
    save_project,
)
from podcast_mcp.services import waveform as svc

SR = 8000


def reset_waveform_caches() -> None:
    svc._INDEX.clear()
    svc._META.clear()
    svc._GC_DONE.clear()


def write_wav(path: Path, frames: int, *, seed: int = 0) -> Path:
    rng = np.random.default_rng(seed)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = rng.integers(-12000, 12000, size=frames, dtype=np.int64).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(data.tobytes())
    return path


def waveform_project(tmp_path: Path, frames: int = 64 * 300) -> Path:
    """host + guest media; a cross-lane clip on guest pins host's file via source s_host."""
    ws = tmp_path / "ws"
    write_wav(ws / "raw" / "host.wav", frames)
    write_wav(ws / "raw" / "guest.wav", frames + 64, seed=1)
    project = EpisodeProject.create("wf", str(ws))
    project.timeline.tracks = [
        Track(id="host", label="Host", media=MediaAsset(path="raw/host.wav")),
        Track(id="guest", label="Guest", media=MediaAsset(path="raw/guest.wav")),
        Track(id="empty", label="Empty"),
        Track(id="gone", label="Gone", media=MediaAsset(path="raw/missing.wav")),
        Track(id="escape", label="Escape", media=MediaAsset(path="../outside.wav")),
    ]
    project.sources = [
        SourceRecording(id="s_host", path="raw/host.wav"),
        SourceRecording(id="unused", path="raw/guest.wav"),
    ]
    project.timeline.clips = [
        Clip(
            id="c1",
            track_id="guest",
            source_start=0.0,
            source_end=1.0,
            timeline_start=0.0,
            source_id="s_host",
        ),
        Clip(
            id="c2",
            track_id="guest",
            source_start=0.0,
            source_end=1.0,
            timeline_start=2.0,
            source_id="ghost",
        ),
    ]
    return save_project(project)
