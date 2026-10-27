"""#2375: a ripple must not make a downstream clip's unchanged fade ramps look like new effects."""

from __future__ import annotations

import pytest

from podcast_mcp.edits import cut_effects
from podcast_mcp.engines.audio import GainRamp
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


@pytest.mark.parametrize("change", ["fade_in", "fade_out", "move"])
def test_a_real_ramp_change_is_still_reported(tmp_path, change):
    project, candidate = _project(tmp_path, 0.7)
    clip = candidate.clips[1]
    if change == "fade_in":
        clip.fade_in_ms = 201
    elif change == "fade_out":
        clip.fade_out_ms = 299
    else:
        clip.source_start += 2e-6
    effects = cut_effects.completed_audio_effects(
        project, candidate, frozenset({"remove"}), defaults={}
    )
    assert [e for e in effects if e.envelope is not None]


@pytest.mark.parametrize(
    ("other", "same"),
    [
        (GainRamp(1.0 + 1e-14, 2.0 - 1e-14, True, "tri"), True),
        (GainRamp(1.0 + 9e-7, 2.0, True, "tri"), True),
        (GainRamp(1.0 + 2e-6, 2.0, True, "tri"), False),
        (GainRamp(1.0, 2.0 + 2e-6, True, "tri"), False),
        (GainRamp(1.0, 2.0, False, "tri"), False),
        (GainRamp(1.0, 2.0, True, "qsin"), False),
    ],
)
def test_same_envelope_tolerates_only_float_noise(other, same):
    assert cut_effects._same_envelope(GainRamp(1.0, 2.0, True, "tri"), other) is same
