"""``unfiltered_track_audio`` reads the track grid without resolving FFmpeg (#2456).

track_evidence plans through it on every lookup, cache hits included.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pause_policy_public_helpers import room, voice, write_wav
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import unfiltered_track_audio
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole
from podcast_mcp.util.batch_scope import batch_scope


def _project(tmp_path: Path) -> EpisodeProject:
    audio = room(seconds=5, seed=2456, db=-70)
    voice(audio, 1, 2)
    write_wav(tmp_path / "raw/host.wav", audio)
    project = EpisodeProject.create("unfiltered engine", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=5),
        )
    ]
    project.clips = [
        Clip(id="a", track_id="host", source_start=0, source_end=2, timeline_start=0),
        Clip(id="b", track_id="host", source_start=2, source_end=5, timeline_start=2.0),
    ]
    return project


def test_unfiltered_track_audio_resolves_no_ffmpeg(tmp_path, monkeypatch):
    if not FFmpegEngine().check_available()[0]:
        pytest.skip("ffmpeg not available")
    project = _project(tmp_path)
    with batch_scope():
        warm = unfiltered_track_audio(project, project.tracks[0], {})
        monkeypatch.setenv("PODCAST_MCP_FFMPEG", str(tmp_path / "missing-ffmpeg"))
        monkeypatch.setenv("PODCAST_MCP_FFPROBE", str(tmp_path / "missing-ffprobe"))
        with pytest.raises(Exception, match="missing-ffmpeg"):
            FFmpegEngine()
        assert unfiltered_track_audio(project, project.tracks[0], {}) == warm
    assert warm is not None
