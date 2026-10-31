"""A clip with a timing map renders as its virtual pieces (#2858, umbrella #1089)."""

from __future__ import annotations

import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.engines import room_tone
from podcast_mcp.engines.timed_pieces import expand_timed_clips
from podcast_mcp.engines.timeline_render import render_track_from_timeline
from podcast_mcp.engines.ungated_audio import raw_timeline_samples, raw_timeline_window
from podcast_mcp.models import Clip, ClipJoinMode, EpisodeProject, MediaAsset, Track, TrackRole

RATE = 16_000
MICRO_MS = 10
_STEPS = [
    {"at": 1.0, "delta_sec": 0.2},
    {"at": 2.0, "delta_sec": -0.1, "quiet": {"start_s": 2.0, "end_s": 2.5}},
    {"at": 3.0, "delta_sec": 0.15},
]
_HOLES = [(1.0, 1.2), (3.1, 3.25)]
# (source_start, source_end, timeline_start) of the four pieces the steps above make.
_PIECES = [(0.0, 1.0, 0.0), (1.0, 2.0, 1.2), (2.1, 3.0, 2.2), (3.0, 4.0, 3.25)]


def _frames(seconds: float) -> int:
    return round(seconds * RATE)


def _source(room: float = 0.0) -> np.ndarray:
    noise = np.random.default_rng(7).uniform(-1, 1, 8 * RATE)
    signal = 0.3 * noise
    signal[_frames(2.0) : _frames(2.1)] = 0.0
    signal[_frames(5.0) :] = room * noise[_frames(5.0) :]
    return signal


def _project(tmp_path: Path, clips: list[Clip], signal: np.ndarray) -> EpisodeProject:
    (tmp_path / "raw").mkdir(parents=True)
    with wave.open(str(tmp_path / "raw" / "host.wav"), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes((signal * 32767).astype("<i2").tobytes())
    project = EpisodeProject.create("timed", str(tmp_path))
    project.timeline.tracks.append(
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=8.0),
        )
    )
    project.timeline.clips = clips
    return project


def _mapped() -> Clip:
    return Clip.model_validate(
        {
            "id": "lane",
            "track_id": "host",
            "source_start": 0.0,
            "source_end": 4.0,
            "timeline_start": 0.0,
            "timing": {"steps": _STEPS},
        }
    )


def _four_clips() -> list[Clip]:
    last = len(_PIECES) - 1
    return [
        Clip(
            id=f"p{index}",
            track_id="host",
            source_start=src_a,
            source_end=src_b,
            timeline_start=tl_a,
            fade_in_ms=MICRO_MS if index else 0,
            fade_out_ms=MICRO_MS if index < last else 0,
            join_in_mode=ClipJoinMode.FADE,
        )
        for index, (src_a, src_b, tl_a) in enumerate(_PIECES)
    ]


def _render(project: EpisodeProject, tmp_path: Path) -> np.ndarray:
    out = tmp_path / "artifacts" / "host.wav"
    render_track_from_timeline(project, project.tracks[0], out, {})
    with wave.open(str(out), "rb") as audio:
        assert audio.getframerate() == RATE
        return np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2")


def test_pieces_expand_to_the_geometry_of_the_four_clips() -> None:
    clips, holes = expand_timed_clips([_mapped()])
    assert [(c.source_start, c.source_end, c.timeline_start) for c in clips] == pytest.approx(
        _PIECES
    )
    assert sorted(holes) == [0, 2]
    assert all(c.id == "lane" and c.timing is None for c in clips)


def test_three_step_lane_renders_sample_identical_to_four_pieces(tmp_path: Path) -> None:
    rendered_pieces = _render(
        _project(tmp_path / "pieces", _four_clips(), _source()), tmp_path / "pieces"
    )
    mapped = _render(_project(tmp_path / "map", [_mapped()], _source()), tmp_path / "map")
    assert rendered_pieces.shape == mapped.shape
    assert np.array_equal(rendered_pieces, mapped)
    assert not mapped[_frames(1.0) : _frames(1.2)].any()


def test_hole_without_a_pool_is_digital_silence(tmp_path: Path) -> None:
    project = _project(tmp_path, [_mapped()], _source(room=0.02))
    with patch.object(room_tone, "read_room_tone_pool", return_value=None):
        samples = _render(project, tmp_path)
    for start, end in _HOLES:
        assert not samples[_frames(start) : _frames(end)].any()


def test_hole_with_a_pool_is_the_tracks_room_tone(tmp_path: Path) -> None:
    rendered_with_silent_holes = _render(
        _project(tmp_path / "plain", [_mapped()], _source(room=0.02)), tmp_path / "plain"
    )
    project = _project(tmp_path, [_mapped()], _source(room=0.02))
    pool = (room_tone.Sample(5.0, 7.0, -40.0, None),)
    with patch.object(room_tone, "read_room_tone_pool", return_value=pool):
        samples = _render(project, tmp_path)
    inside = samples[_frames(1.0) + _frames(0.03) : _frames(1.2) - _frames(0.03)].astype(float)
    assert inside.any()
    assert np.sqrt(np.mean((inside / 32767) ** 2)) == pytest.approx(0.02 / np.sqrt(3), rel=0.2)
    elsewhere = np.ones(samples.shape, dtype=bool)
    for start, end in _HOLES:
        elsewhere[_frames(start) : _frames(end)] = False
    delta = np.abs(samples.astype(int) - rendered_with_silent_holes.astype(int))
    assert delta[elsewhere].max() <= 1


def test_negative_step_skips_the_quiet_source_and_adds_no_audio(tmp_path: Path) -> None:
    signal = _source()
    signal[_frames(2.0) : _frames(2.1)] = 0.9
    samples = _render(_project(tmp_path, [_mapped()], signal), tmp_path)
    assert np.abs(samples).max() / 32767 < 0.5
    raw = raw_timeline_samples(
        _project(tmp_path / "raw_s", [_mapped()], signal), "host", sample_rate=RATE
    )
    assert np.abs(raw).max() < 0.5
    assert raw.shape[0] == _frames(4.25)


def test_untimed_clips_are_returned_unchanged(tmp_path: Path) -> None:
    clips = _four_clips()
    assert expand_timed_clips(clips) == (clips, {})
    assert expand_timed_clips(clips)[0] is clips


def test_raw_samples_and_window_follow_the_pieces(tmp_path: Path) -> None:
    signal = _source()
    mapped = raw_timeline_samples(
        _project(tmp_path / "m", [_mapped()], signal), "host", sample_rate=RATE
    )
    pieces = raw_timeline_samples(
        _project(tmp_path / "p", _four_clips(), signal), "host", sample_rate=RATE
    )
    assert np.array_equal(mapped, pieces)
    assert not mapped[_frames(1.0) : _frames(1.2)].any()
    window = raw_timeline_window(
        _project(tmp_path / "w", [_mapped()], signal), "host", 0.9, 2.4, sample_rate=RATE
    )
    assert np.allclose(window, mapped[_frames(0.9) : _frames(2.4)], atol=2e-4)
