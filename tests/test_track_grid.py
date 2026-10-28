"""A track's clips sit on one integer sample grid, so a window and the stem agree (#2456)."""

from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.audio import sources
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.media_seek import MediaSeek
from podcast_mcp.engines.timeline_render import (
    placed_track_audio,
    render_track_from_timeline,
    track_grid,
)
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, SourceRecording, Track, TrackRole

LENGTHS = [2.0123457 + 0.0371 * index for index in range(16)]
SKIP = 0.3000013


def _write_wav(path: Path, seconds: float, rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    noise = np.random.default_rng(rate).standard_normal(round(seconds * rate)) * 0.1
    with wave.open(str(path), "wb") as audio_file:
        audio_file.setnchannels(1)
        audio_file.setsampwidth(2)
        audio_file.setframerate(rate)
        audio_file.writeframes((np.clip(noise, -1, 1) * 32767).astype("<i2").tobytes())


def _project(root: Path, rates: dict[str, int]) -> EpisodeProject:
    project = EpisodeProject.create("grid", str(root))
    for name, rate in rates.items():
        _write_wav(root / "raw" / f"{name}.wav", 60.0, rate)
    first = next(iter(rates))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{first}.wav", duration_sec=60.0),
        )
    ]
    project.sources = [
        SourceRecording(id=name, path=f"raw/{name}.wav", duration_sec=60.0) for name in rates
    ]
    return project


def _joined_clips(source_ids: list[str | None], gap_after: dict[int, float] | None = None):
    clips = []
    timeline = source = 0.0
    for index, length in enumerate(LENGTHS):
        clips.append(
            Clip(
                id=f"c{index}",
                track_id="host",
                source_id=source_ids[index % len(source_ids)],
                source_start=source,
                source_end=source + length,
                timeline_start=timeline,
            )
        )
        timeline += length + (gap_after or {}).get(index, 0.0)
        source += length + SKIP
    return clips


def _frame(seconds: float, rate: int) -> int:
    return math.floor(seconds * rate + 0.5)


@pytest.fixture
def engine() -> FFmpegEngine:
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    return eng


def _piece_lengths(audio, rate: int) -> list[int]:
    lengths = []
    for leaf in sources(audio):
        seek = MediaSeek.at(leaf.src_start, lead_sec=0.0)
        lengths.append(
            seek.first_sample(leaf.src_end, rate) - seek.first_sample(leaf.src_start, rate)
        )
    return lengths


@pytest.mark.parametrize("rate", [44_100, 48_000])
def test_a_joined_run_is_cut_into_pieces_that_sum_to_the_clip_edges(
    tmp_path: Path, engine: FFmpegEngine, rate: int
) -> None:
    project = _project(tmp_path, {"host": rate})
    clips = _joined_clips([None])
    track = project.tracks[0]
    grid = track_grid(project, track, clips, engine)
    assert grid is not None
    assert grid.rate == rate

    stem = placed_track_audio(project, track, clips, grid=grid)
    expected = [
        _frame(clip.timeline_end, rate) - _frame(clip.timeline_start, rate) for clip in clips
    ]
    assert _piece_lengths(stem.audio, rate) == expected
    assert sum(expected) == _frame(clips[-1].timeline_end, rate)
    assert sum(expected) == {44_100: 1_616_244, 48_000: 1_759_177}[rate]

    window = (clips[3].timeline_start + 0.37, clips[12].timeline_start + 0.61)
    windowed = placed_track_audio(project, track, clips, grid=grid, window=window)
    first, last = _frame(window[0], rate), _frame(window[1], rate)
    cut = _piece_lengths(windowed.audio, rate)
    assert sum(cut) == last - first
    assert cut[1:-1] == expected[4:12]
    assert windowed.extent is not None
    assert windowed.extent.seconds == pytest.approx((last - first) / rate, abs=1e-5)


def test_a_window_piece_starts_on_the_stem_sample_of_its_source(
    tmp_path: Path, engine: FFmpegEngine
) -> None:
    project = _project(tmp_path, {"host": 48_000})
    clips = _joined_clips([None])
    track = project.tracks[0]
    grid = track_grid(project, track, clips, engine)
    assert grid is not None
    stem = placed_track_audio(project, track, clips, grid=grid)
    start = clips[9].timeline_start + 0.37
    windowed = placed_track_audio(project, track, clips, grid=grid, window=(start, start + 1.0))
    leaf = sources(windowed.audio)[0]
    offset = _frame(clips[9].timeline_start, 48_000)
    clip_first = grid.source_frame(leaf.path, clips[9].source_start)
    window_first = grid.source_frame(leaf.path, leaf.src_start)
    assert window_first == clip_first + _frame(start, 48_000) - offset
    assert sources(stem.audio)[9].src_start == pytest.approx(clips[9].source_start)


def test_a_track_of_mixed_sample_rates_keeps_float_placement(
    tmp_path: Path, engine: FFmpegEngine
) -> None:
    project = _project(tmp_path, {"wide": 48_000, "narrow": 22_050})
    clips = _joined_clips(["wide", "narrow"])[:4]
    track = project.tracks[0]
    assert track_grid(project, track, clips, engine) is None

    placed = placed_track_audio(project, track, clips, grid=None)
    assert [leaf.src_end - leaf.src_start for leaf in sources(placed.audio)] == [
        clip.source_end - clip.source_start for clip in clips
    ]
    project.timeline.clips = clips
    output = tmp_path / "mixed.wav"
    render_track_from_timeline(project, track, output, {}, engine=engine)
    with wave.open(str(output)) as rendered:
        assert rendered.getnframes() > 0


def test_a_track_above_the_grid_rate_limit_keeps_float_placement(
    tmp_path: Path, engine: FFmpegEngine
) -> None:
    project = _project(tmp_path, {"host": 384_000})
    clips = _joined_clips([None])[:2]
    assert track_grid(project, project.tracks[0], clips, engine) is None


def test_a_window_decides_grid_or_float_from_the_whole_track(
    tmp_path: Path, engine: FFmpegEngine
) -> None:
    project = _project(tmp_path, {"wide": 48_000, "narrow": 22_050})
    clips = _joined_clips(["wide", "narrow"])[:6]
    track = project.tracks[0]
    assert track_grid(project, track, clips, engine) is None
    # Clip 0 alone is one rate, but the stem has no grid, so the window must not either.
    window = (clips[0].timeline_start + 0.1, clips[0].timeline_end - 0.1)
    assert track_grid(project, track, clips, engine, window=window) is None
    # A uniform track still gets a grid for a window, with seeks for the window's clips only.
    uniform = _project(tmp_path / "uniform", {"wide": 48_000})
    clips = _joined_clips(["wide"])[:6]
    grid = track_grid(uniform, uniform.tracks[0], clips, engine, window=window)
    assert grid is not None
    assert len(grid.seeks) == 1
