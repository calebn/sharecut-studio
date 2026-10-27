"""#2375: a ripple must not make a downstream clip's unchanged fade ramps look like new effects."""

from __future__ import annotations

import pytest

from podcast_mcp.edits import cut_effects
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole


def _project(tmp_path, shift: float) -> tuple[EpisodeProject, EpisodeProject]:
    project = EpisodeProject.create("ramp tolerance", str(tmp_path))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=60),
        )
    ]
    project.clips = [
        Clip(id="a", track_id="host", source_start=0, source_end=10, timeline_start=0),
        Clip(
            id="b",
            track_id="host",
            source_start=10.1,
            source_end=30.3,
            timeline_start=10,
            fade_in_ms=200,
            fade_out_ms=300,
        ),
    ]
    candidate = project.model_copy(deep=True)
    candidate.clips[0].source_end = 10 - shift
    candidate.clips[1].timeline_start = 10 - shift
    return project, candidate


@pytest.mark.parametrize("shift", [0.3, 0.7, 1.1, 2.3, 3.7])
def test_ripple_does_not_make_downstream_fade_ramps_look_new(tmp_path, shift):
    project, candidate = _project(tmp_path, shift)
    effects = cut_effects.completed_audio_effects(
        project, candidate, frozenset({"remove"}), defaults={}
    )
    downstream = [e for e in effects if e.envelope is not None]
    assert downstream == []
