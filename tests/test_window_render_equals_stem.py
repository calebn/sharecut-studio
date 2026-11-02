from __future__ import annotations

import math
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import render_track_from_timeline, render_track_segment
from podcast_mcp.models import (
    Clip,
    EpisodeProject,
    MediaAsset,
    ProcessingChain,
    ProcessingEffect,
    Track,
    TrackRole,
)

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


def _layout_project(
    root: Path,
    *,
    rate: int,
    first_start: float,
    gap_before: dict[int, float],
    highpass: bool,
) -> EpisodeProject:
    rng = np.random.default_rng(5)
    samples = np.clip(rng.standard_normal(round(40.0 * rate)) * 0.1, -1, 1)
    (root / "raw").mkdir()
    with wave.open(str(root / "raw" / "host.wav"), "wb") as audio_file:
        audio_file.setnchannels(1)
        audio_file.setsampwidth(2)
        audio_file.setframerate(rate)
        audio_file.writeframes((samples * 32767).astype("<i2").tobytes())
    project = EpisodeProject.create("layout", str(root))
    project.timeline.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path="raw/host.wav", duration_sec=40.0),
        )
    ]
    if highpass:
        project.processing_chains = [
            ProcessingChain(
                track_id="host",
                effects=[ProcessingEffect(effect="highpass", params={"frequency": 80})],
            )
        ]
    clips: list[Clip] = []
    timeline, source = first_start, 0.0
    for index in range(10):
        timeline += gap_before.get(index, 0.0)
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
    return project


LAYOUTS = {
    "late_first_clip_48k": (48_000, 12.3456789, {}, False),
    "late_first_clip_44k": (44_100, 0.123457, {}, False),
    "gap_before_run_48k": (48_000, 0.0, {5: 0.2}, False),
    "gap_before_run_44k": (44_100, 0.0, {5: 0.2}, False),
    "late_first_clip_and_gaps_48k": (48_000, 12.3456789, {3: 0.2, 6: 0.31}, False),
    "late_first_clip_and_gap_highpass_48k": (48_000, 12.3456789, {5: 0.2}, True),
}


@pytest.mark.parametrize("layout", list(LAYOUTS))
def test_window_equals_the_stem_for_runs_that_start_off_the_sample_grid(
    tmp_path: Path, layout: str
) -> None:
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    rate, first_start, gaps, highpass = LAYOUTS[layout]
    project = _layout_project(
        tmp_path, rate=rate, first_start=first_start, gap_before=gaps, highpass=highpass
    )
    stem_path = tmp_path / "stem.wav"
    render_track_from_timeline(project, project.tracks[0], stem_path, {}, engine=eng)
    stem = _read_pcm(stem_path)
    if first_start:
        assert int(np.flatnonzero(stem)[0]) == round(first_start * rate)
    # The filter's state differs at a window start, so its ringing is skipped, and int16
    # rounding of the two float paths leaves a few one-step differences that the
    # filter's output does not hide; a one-sample shift would sit near -3 dB.
    settle = round(0.25 * rate) if highpass else 0
    limit_db = -70 if highpass else -100
    clips = project.timeline.clips
    windows = [(index, 0.37) for index in range(1, 10)] + [(index, 0.0) for index in gaps]
    for index, offset in windows:
        start = clips[index].timeline_start + offset
        if start + 5.0 > project.timeline.duration_sec:
            continue
        segment_path = tmp_path / f"segment_{index}_{offset}.wav"
        render_track_segment(project, "host", start, start + 5.0, segment_path, {}, engine=eng)
        window = _read_pcm(segment_path)
        first = round(start * rate)
        expected = stem[first : first + len(window)]
        assert len(window) == 5 * rate
        assert _best_lag(window[settle:], stem, first + settle) == 0
        residual = float(np.sum((window[settle:] - expected[settle:]) ** 2))
        energy = float(np.sum(expected[settle:] ** 2))
        assert 10 * math.log10((residual + 1e-12) / energy) < limit_db


@pytest.mark.parametrize("rate", [48_000, 44_100])
@pytest.mark.parametrize("lead_ms", [120.0, 60.0, 40.0, 10.0, 1.1, 0.9, 0.4, 0.0])
def test_window_opening_just_before_a_clip_after_a_gap_equals_the_stem(
    tmp_path: Path, rate: int, lead_ms: float
) -> None:
    """A window that starts a few ms before a clip that follows a pause keeps the pause (#2498).

    The stem snaps a clip to the one before it only when the gap is under JOIN_GAP_TOLERANCE_SEC;
    the window must not snap to its own start because it cannot see the clip it opens after.
    """
    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    project = _layout_project(
        tmp_path, rate=rate, first_start=0.0, gap_before={5: 0.15}, highpass=False
    )
    stem_path = tmp_path / "stem.wav"
    render_track_from_timeline(project, project.tracks[0], stem_path, {}, engine=eng)
    stem = _read_pcm(stem_path)
    start = project.timeline.clips[5].timeline_start - lead_ms / 1000
    segment_path = tmp_path / "segment.wav"
    render_track_segment(project, "host", start, start + 2.0, segment_path, {}, engine=eng)
    window = _read_pcm(segment_path)
    first = round(start * rate)
    expected = stem[first : first + len(window)]
    assert len(window) == round(2.0 * rate)
    assert _best_lag(window, stem, first) == 0
    residual = float(np.sum((window - expected) ** 2))
    assert 10 * math.log10((residual + 1e-12) / float(np.sum(expected**2))) < -100


@pytest.mark.parametrize("rate", [48_000, 44_100])
@pytest.mark.parametrize(
    "window", [(3.0, 4.0), (3.5, 4.5), (3.6, 4.6), (8.0, 9.0), (2.5, 3.5), (2.6, 3.6)]
)
def test_window_through_a_filled_mute_plays_the_stems_room_tone_tiles(
    tmp_path: Path, rate: int, window: tuple[float, float]
) -> None:
    """The fill's tiles are laid out over the whole mute, so a window cuts them, not re-tiles (#2498)."""
    from podcast_mcp.models import ClipMuteRegion, RoomToneFill

    eng = FFmpegEngine()
    if not eng.check_available()[0]:
        pytest.skip("ffmpeg not available")
    project = _layout_project(tmp_path, rate=rate, first_start=0.0, gap_before={}, highpass=False)
    clip = Clip(id="m", track_id="host", source_start=0.0, source_end=10.0, timeline_start=0.0)
    clip.mute_regions = [
        ClipMuteRegion(start_s=3.0, end_s=5.0, fill=RoomToneFill(start_s=20.0, end_s=20.45))
    ]
    project.timeline.clips = [clip]
    project.timeline.duration_sec = 10.0
    stem_path = tmp_path / "stem.wav"
    render_track_from_timeline(project, project.tracks[0], stem_path, {}, engine=eng)
    stem = _read_pcm(stem_path)
    segment_path = tmp_path / "segment.wav"
    render_track_segment(project, "host", window[0], window[1], segment_path, {}, engine=eng)
    got = _read_pcm(segment_path)
    first = round(window[0] * rate)
    expected = stem[first : first + len(got)]
    assert len(got) == round((window[1] - window[0]) * rate)
    assert _best_lag(got, stem, first) == 0
    residual = float(np.sum((got - expected) ** 2))
    assert 10 * math.log10((residual + 1e-12) / float(np.sum(expected**2))) < -100
