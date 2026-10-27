from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import render_track_from_timeline, render_track_segment
from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole

RATE = 48_000
WINDOW_SEC = 1.0


@pytest.fixture(scope="module")
def joined_clip_project(tmp_path_factory: pytest.TempPathFactory) -> tuple[EpisodeProject, Path]:
    """Gap-free clips of fractional length over seeded noise, each skipping a little source.

    The lengths are off the sample grid, so the stem's concatenated pieces drift from
    ``timeline_start * RATE`` by up to a sample or two (#2456).
    """
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    root = tmp_path_factory.mktemp("window_equals_stem")
    rng = np.random.default_rng(3)
    source_sec = 40.0
    samples = np.clip(rng.standard_normal(round(source_sec * RATE)) * 0.1, -1, 1)
    (root / "raw").mkdir()
    with wave.open(str(root / "raw" / "host.wav"), "wb") as audio_file:
        audio_file.setnchannels(1)
        audio_file.setsampwidth(2)
        audio_file.setframerate(RATE)
        audio_file.writeframes((samples * 32767).astype("<i2").tobytes())

    project = EpisodeProject.create("window_equals_stem", str(root))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=source_sec),
        )
    ]
    clips: list[Clip] = []
    timeline = source = 0.0
    for index in range(10):
        length = float(rng.uniform(2.0, 3.5))
        clips.append(
            Clip(
                id=f"c{index}",
                track_id="host",
                source_start=source,
                source_end=source + length,
                timeline_start=timeline,
            )
        )
        timeline += length
        source += length + float(rng.uniform(0.2, 0.8))
    project.timeline.clips = clips
    project.timeline.duration_sec = timeline
    stem = root / "stem.wav"
    render_track_from_timeline(project, project.tracks[0], stem, {}, engine=eng)
    return project, stem


def _read_pcm(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as audio_file:
        return np.frombuffer(audio_file.readframes(audio_file.getnframes()), dtype="<i2").astype(
            np.float64
        )


def _best_lag(window: np.ndarray, stem: np.ndarray, start_sample: int, span: int = 4) -> int:
    n = len(window)
    errors = {
        lag: float(np.sum((window - stem[start_sample + lag : start_sample + lag + n]) ** 2))
        for lag in range(-span, span + 1)
    }
    return min(errors, key=lambda lag: errors[lag])


@pytest.mark.parametrize("clip_index", range(1, 10))
def test_window_starting_inside_a_joined_clip_equals_the_stem(
    joined_clip_project: tuple[EpisodeProject, Path], tmp_path: Path, clip_index: int
) -> None:
    project, stem_path = joined_clip_project
    clip = project.timeline.clips[clip_index]
    start = clip.timeline_start + 0.37
    segment_path = tmp_path / "segment.wav"
    render_track_segment(
        project, "host", start, start + WINDOW_SEC, segment_path, {}, engine=FFmpegEngine()
    )
    window = _read_pcm(segment_path)
    stem = _read_pcm(stem_path)
    first = round(start * RATE)
    expected = stem[first : first + len(window)]
    assert len(window) == round(WINDOW_SEC * RATE)
    assert _best_lag(window, stem, first) == 0
    residual = float(np.sum((window - expected) ** 2))
    energy = float(np.sum(expected**2))
    assert 10 * math.log10((residual + 1e-12) / energy) < -100
