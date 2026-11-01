"""Readers of a clip's shift map a clip with a timing map point by point (#2860, stage 4a)."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from podcast_mcp.engines.bleed_gate import _scope_intervals
from podcast_mcp.engines.room_tone import _pool_spans_in_use
from podcast_mcp.engines.session_timeline import (
    SessionTimeline,
    clip_source_at_timeline,
    same_source_timeline_overlaps,
)
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    RoomToneFill,
    Track,
    TrackRole,
    TranscriptGateScope,
)
from podcast_mcp.services.media.ingest import _timeline_vad_intervals, _waveform_file_start

# Pieces: source 10-20 at timeline 100, a 2 s hole, 20-30 at 112, a 1 s skip, 31-40 at 122.
_STEPS = [
    {"at": 20, "delta_sec": 2},
    {"at": 30, "delta_sec": -1, "quiet": {"start_s": 29, "end_s": 32}},
]


def _clip(**kw) -> Clip:
    base = {
        "id": "a",
        "track_id": "host",
        "source_start": 10,
        "source_end": 40,
        "timeline_start": 100,
        "timing": {"steps": _STEPS},
    }
    return Clip.model_validate({**base, **kw})


def _project(*clips: Clip, tracks: int = 1) -> EpisodeProject:
    project = EpisodeProject.create("timed_consumers", "/tmp/ws-timed-consumers")
    ids = ["host", "guest"][:tracks]
    project.timeline.tracks = [
        Track(
            id=tid,
            label=tid,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/shared.wav", duration_sec=300.0),
        )
        for tid in ids
    ]
    project.timeline.clips = list(clips)
    return project


@pytest.mark.parametrize(
    ("timeline_sec", "source_sec"),
    [
        (105.0, 15.0),
        (115.0, 23.0),
        (125.0, 34.0),
        (110.5, 20.0),
        (111.5, 20.0),
        (99.0, 9.0),
        (133.0, 42.0),
    ],
)
def test_the_source_clock_at_a_timeline_second_goes_through_the_piece_that_plays(
    timeline_sec: float, source_sec: float
) -> None:
    assert clip_source_at_timeline(_clip(), timeline_sec) == pytest.approx(source_sec)


def test_the_source_clock_of_an_untimed_clip_is_unchanged() -> None:
    clip = Clip(id="a", track_id="host", source_start=10, source_end=40, timeline_start=100)
    assert clip_source_at_timeline(clip, 115.0) == 25.0


def test_relative_drift_scores_each_piece_of_a_timed_clip() -> None:
    reference = Clip(id="r", track_id="guest", source_start=100, source_end=130, timeline_start=100)
    timed = _clip()
    drift = SessionTimeline(_project(timed, reference, tracks=2)).clip_relative_drift(
        timed, "guest"
    )
    assert drift == pytest.approx(-92.0)


def test_a_mute_region_after_a_step_overlaps_where_it_plays() -> None:
    muted = _clip(off_speaker_mute_regions=[{"start_s": 33, "end_s": 38}])
    other = Clip(id="b", track_id="guest", source_start=10, source_end=40, timeline_start=100)
    stacks = same_source_timeline_overlaps(_project(muted, other, tracks=2))
    assert len(stacks) == 1
    # Timeline 100 to 130 overlaps; source 33 to 38 plays at 124 to 129 and is muted.
    assert stacks[0].overlap_sec == pytest.approx(25.0, abs=1e-6)


@pytest.mark.parametrize(("start", "end", "expected"), [(29.5, 30.5, 29.5), (30.2, 30.8, 30.0)])
def test_a_mute_region_touching_a_skip_mutes_only_the_audible_part(
    start: float, end: float, expected: float
) -> None:
    muted = _clip(off_speaker_mute_regions=[{"start_s": start, "end_s": end}])
    other = Clip(id="b", track_id="guest", source_start=10, source_end=40, timeline_start=100)
    stacks = same_source_timeline_overlaps(_project(muted, other, tracks=2))
    assert stacks[0].overlap_sec == pytest.approx(expected, abs=1e-6)


def test_a_gate_scope_crossing_a_step_gives_one_interval_per_piece() -> None:
    clip = _clip(source_id="src")
    project = _project(clip)
    track = project.timeline.tracks[0]
    track.transcript_gate_scope = [TranscriptGateScope(start_s=15, end_s=35, source_id="src")]
    assert _scope_intervals(project, "host") == [(105.0, 110.0), (112.0, 126.0)]


def test_the_room_tone_pool_in_use_is_placed_after_the_step() -> None:
    clip = _clip(
        mute_regions=[
            {
                "start_s": 33,
                "end_s": 35,
                "fill": RoomToneFill(start_s=5, end_s=7).model_dump(),
            }
        ]
    )
    project = _project(clip)
    inside = _pool_spans_in_use(project, "host", [], 125.5)
    far = _pool_spans_in_use(project, "host", [], 400.0)
    assert inside == [(5.0, 7.0)]
    assert far == []


def test_the_vad_window_crossing_a_step_reads_each_piece_with_its_own_shift() -> None:
    project = _project(_clip())
    track = project.timeline.tracks[0]
    calls: list[tuple[float, float]] = []

    def fake_vad(_path, *, start_sec, duration_sec):
        calls.append((start_sec, duration_sec))
        return [(start_sec, start_sec + 1.0)]

    with (
        patch("podcast_mcp.services.media.ingest.vad_speech_intervals", fake_vad),
        patch("podcast_mcp.engines.timeline_render.resolve_clip_audio_path", lambda *a: "x"),
    ):
        intervals = _timeline_vad_intervals(
            project, track, window_start_sec=118.0, window_end_sec=125.0
        )
    assert calls == [(26.0, 4.0), (31.0, 3.0)]
    assert intervals == [(118.0, 119.0), (122.0, 123.0)]


def test_the_waveform_file_start_of_a_timed_first_clip_is_its_base_shift() -> None:
    project = _project(_clip())
    assert _waveform_file_start(project, project.timeline.tracks[0]) == -90.0
