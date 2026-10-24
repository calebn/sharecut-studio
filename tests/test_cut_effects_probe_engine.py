from __future__ import annotations

from pathlib import Path

import pytest

from pause_policy_public_helpers import room, voice, write_wav
from podcast_mcp.edits import cut_effects
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole
from podcast_mcp.models.episode import ClipMuteRegion
from podcast_mcp.util import binaries
from podcast_mcp.util.batch_scope import batch_scope


def _muted_pair(tmp_path: Path) -> tuple[EpisodeProject, EpisodeProject]:
    path = tmp_path / "raw/host.wav"
    audio = room(seconds=5, seed=1958, db=-70)
    voice(audio, 1, 2)
    write_wav(path, audio)
    project = EpisodeProject.create("probe engine", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=5),
        )
    ]
    project.clips = [
        Clip(
            id="muted",
            track_id="host",
            source_start=0,
            source_end=5,
            timeline_start=0,
            mute_regions=[ClipMuteRegion(start_s=1, end_s=2)],
        ),
        Clip(id="target", track_id="host", source_start=0, source_end=5, timeline_start=5.25),
    ]
    candidate = project.model_copy(deep=True)
    candidate.clips[1].source_start = 1.3
    candidate.clips[1].fade_in_ms = 10
    return project, candidate


def test_probe_cache_hit_constructs_no_ffmpeg_engine(tmp_path, monkeypatch):
    project, candidate = _muted_pair(tmp_path)
    calls: list[tuple] = []
    real = binaries.resolve_ffmpeg_pair

    def counting(*args, **kwargs):
        calls.append(args)
        return real(*args, **kwargs)

    monkeypatch.setattr("podcast_mcp.engines.ffmpeg.resolve_ffmpeg_pair", counting)

    def run():
        return cut_effects.completed_audio_effects(
            project, candidate, frozenset({"remove"}), defaults={}
        )

    with batch_scope():
        first = run()
        after_first = len(calls)
        second = run()
    assert first == second
    assert any(effect.envelope is not None for effect in first)
    assert after_first == 1  # one distinct muted source path: one real probe
    assert len(calls) == after_first, "a probe cache hit must not resolve the ffmpeg pair"


def test_probe_resolution_error_surfaces_only_on_a_miss(tmp_path, monkeypatch):
    project, candidate = _muted_pair(tmp_path)
    with batch_scope():
        cut_effects.completed_audio_effects(project, candidate, frozenset({"r"}), defaults={})

        def broken(*_args, **_kwargs):
            raise AssertionError("pair resolved on a cache hit")

        monkeypatch.setattr("podcast_mcp.engines.ffmpeg.resolve_ffmpeg_pair", broken)
        cut_effects.completed_audio_effects(project, candidate, frozenset({"r"}), defaults={})
    with pytest.raises(AssertionError):
        with batch_scope():
            cut_effects.completed_audio_effects(project, candidate, frozenset({"r"}), defaults={})
