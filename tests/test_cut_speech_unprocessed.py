"""Speech-guard batch reads use pre-chain evidence (#1526)."""

from __future__ import annotations

from unittest.mock import patch

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.cut_speech import _own_sound
from podcast_mcp.edits.ripple import RippleRemoval, TrackExtent
from podcast_mcp.engines.audio_audit import TrackRmsCacheSet
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole


def test_own_sound_batch_builds_unprocessed_rms_caches() -> None:
    project = EpisodeProject.create("ep", "/tmp/ep")
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=10.0),
        ),
        Track(
            id="guest",
            label="Guest",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/guest.wav", duration_sec=10.0),
        ),
    ]
    project.clips = [
        Clip(id="h", track_id="host", source_start=0, source_end=10, timeline_start=0),
        Clip(id="g", track_id="guest", source_start=0, source_end=10, timeline_start=0),
    ]
    removal = RippleRemoval(
        selected=(TrackExtent(track_id="host", start=0.0, end=10.0),),
        spans=((0.0, 10.0),),
    )
    parts = [(i * 0.1, i * 0.1 + 0.05) for i in range(9)]
    cfg = {"tighten": {"speech_energy_guard": {"enabled": True}}}
    unprocessed_flags: list[bool] = []

    def capture(project, *, track_ids=None, unprocessed=False, **kw):
        unprocessed_flags.append(unprocessed)
        return TrackRmsCacheSet()

    with patch("podcast_mcp.edits.cut_speech.build_track_rms_caches", side_effect=capture):
        _own_sound(
            project, removal, [("guest", parts)], ["host", "guest"], cfg, defaults=load_defaults()
        )

    assert unprocessed_flags == [True]
