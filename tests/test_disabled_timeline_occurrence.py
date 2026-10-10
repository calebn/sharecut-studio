from __future__ import annotations

import pytest

from podcast_mcp.edits.inaudible_cuts import InaudibleCutConfig, optimize_timeline_cut_range
from podcast_mcp.models import Clip, EpisodeProject, Track, TrackRole


def _replay(tmp_path, role):
    result = EpisodeProject.create("selected replay", str(tmp_path))
    result.tracks = [Track(id="host", label="Host", role=role)]
    result.clips = [
        Clip(id="first", track_id="host", source_start=1, source_end=2, timeline_start=0),
        Clip(id="selected", track_id="host", source_start=1, source_end=2, timeline_start=3),
    ]
    result.timeline.duration_sec = 4
    return result


@pytest.mark.parametrize("role", [TrackRole.DIALOGUE, TrackRole.MUSIC])
@pytest.mark.parametrize(
    ("enabled", "override", "expected"),
    [
        (False, None, (3, 4)),
        (False, False, (3, 4)),
        (True, False, (3, 4)),
        (True, None, (0, 1)),
        (False, True, (0, 1)),
        (True, True, (0, 1)),
    ],
)
def test_disable_configuration_and_overrides_preserve_the_selected_occurrence(
    tmp_path, role, enabled, override, expected
):
    result = optimize_timeline_cut_range(
        _replay(tmp_path, role),
        "host",
        3,
        4,
        config=InaudibleCutConfig(enabled=enabled),
        force_enabled=override,
    )
    assert (result.start, result.end) == expected
    assert (result.shifted_start_ms, result.shifted_end_ms, result.confidence) == (0, 0, 1)
    assert result.details["strategy"] == (
        "word+waveform" if role == TrackRole.DIALOGUE else "waveform"
    )
    assert result.details["trailing_energy_extended"] is False
    assert result.details["absorb_trailing_silence"] is False


def test_disabled_tiny_span_retains_exact_timeline_bounds_and_source_normalization(tmp_path):
    result = optimize_timeline_cut_range(
        _replay(tmp_path, TrackRole.DIALOGUE),
        "host",
        3,
        3.00001,
        config=InaudibleCutConfig(enabled=False),
    )
    assert (result.start, result.end) == (3, 3.00001)
    assert result.shifted_start_ms == 0
    assert result.shifted_end_ms == pytest.approx(0.99)
    assert result.confidence == 0.994
