"""Seeked reads land on the requested source sample for every container (#1141).

One 48 kHz source holds three one-sample clicks. Each path reads a window that
starts at ``CLIP_START`` (source sample 59 259), so the speech click must land at
output sample 96 000 and a room-tone fill's click at its literal position in the
filled hole. AAC (``.m4a``) used to land up to one 1024-sample frame early on
every input-seeked path.
"""

from __future__ import annotations

import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.ffmpeg import FFmpegEngine, PlacedSegment
from podcast_mcp.engines.media_seek import MediaSeek
from podcast_mcp.engines.timeline_render import render_track_from_timeline, render_track_segment
from podcast_mcp.models import (
    Clip,
    ClipMuteRegion,
    EpisodeProject,
    MediaAsset,
    RoomToneFill,
    Track,
    TrackRole,
)
from podcast_mcp.util.binaries import resolve_ffmpeg

SR = 48_000
CLIP_START = 1.2345678
SPEECH_CLICK = 155_259
FILL_AFTER_CLIP = RoomToneFill(start_s=1.5, end_s=2.0)
FILL_BEFORE_CLIP = RoomToneFill(start_s=0.2, end_s=0.7)
FILL_CLICKS = (76_800, 14_400)  # 0.1 s into each fill
CONTAINERS = {
    "wav": [],
    "flac": ["-c:a", "flac"],
    "mp3": ["-c:a", "libmp3lame", "-b:a", "192k"],
    "m4a": ["-c:a", "aac", "-b:a", "192k"],
}


@pytest.fixture(scope="module")
def media(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    root = tmp_path_factory.mktemp("seek")
    x = np.random.default_rng(0).standard_normal(6 * SR).astype(np.float32) * 0.001
    for sample in (SPEECH_CLICK, *FILL_CLICKS):
        x[sample] = 0.9
    source = root / "source.wav"
    with wave.open(str(source), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())
    out: dict[str, Path] = {}
    for ext, codec in CONTAINERS.items():
        path = root / f"click.{ext}"
        subprocess.run(
            [resolve_ffmpeg(), "-y", "-v", "error", "-i", str(source), *codec, str(path)],
            check=True,
        )
        out[ext] = path
    return out


def _decode(path: Path) -> np.ndarray:
    result = subprocess.run(
        [resolve_ffmpeg(), "-v", "error", "-i", str(path), "-ac", "1", "-f", "f32le", "pipe:1"],
        capture_output=True,
        check=True,
    )
    return np.frombuffer(result.stdout, dtype=np.float32)


def _click_near(samples: np.ndarray, expected: int) -> int:
    lo = expected - 4_000
    return int(np.argmax(np.abs(samples[lo:]) > 0.3)) + lo


def _render(
    path: Path, out: Path, fill: RoomToneFill | None, clip_start: float = CLIP_START
) -> np.ndarray:
    project = EpisodeProject.create("seek", str(path.parent))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=path.name, duration_sec=6.0),
        )
    ]
    clip = Clip(id="c", track_id="host", source_start=clip_start, source_end=5.5, timeline_start=0)
    if fill is not None:
        clip.mute_regions = [ClipMuteRegion(start_s=4.6, end_s=4.9, fill=fill)]
    project.clips = [clip]
    project.timeline.duration_sec = 5.5 - clip_start
    render_track_from_timeline(project, project.tracks[0], out, {})
    return _decode(out)


@pytest.mark.parametrize("ext", CONTAINERS)
def test_single_source_render_lands_on_the_clip_start(
    media: dict[str, Path], tmp_path: Path, ext: str
) -> None:
    rendered = _render(media[ext], tmp_path / "out.wav", None)
    assert _click_near(rendered, 96_000) == 96_000


@pytest.mark.parametrize("ext", CONTAINERS)
def test_room_tone_render_keeps_speech_and_fill_on_their_samples(
    media: dict[str, Path], tmp_path: Path, ext: str
) -> None:
    after = _render(media[ext], tmp_path / "after.wav", FILL_AFTER_CLIP)
    before = _render(media[ext], tmp_path / "before.wav", FILL_BEFORE_CLIP)
    # The hole opens at 3365 ms (overlaps place fills on a whole millisecond).
    assert _click_near(after, 96_000) == 96_000
    assert _click_near(after, 166_320) == 166_320
    assert _click_near(before, 96_000) == 96_000
    assert _click_near(before, 166_320) == 166_320


@pytest.mark.parametrize("ext", CONTAINERS)
def test_room_tone_render_from_the_file_start_keeps_its_first_frame(
    media: dict[str, Path], tmp_path: Path, ext: str
) -> None:
    # A source range that starts at 0 used to be input-seeked to 0, which drops an
    # AAC file's first real frame and moves the whole track 1024 samples early.
    rendered = _render(media[ext], tmp_path / "out.wav", FILL_AFTER_CLIP, clip_start=0.0)
    assert _click_near(rendered, SPEECH_CLICK) == SPEECH_CLICK
    assert _click_near(rendered, 225_600) == 225_600


@pytest.mark.parametrize("ext", CONTAINERS)
def test_extract_segment_lands_on_the_window_start(
    media: dict[str, Path], tmp_path: Path, ext: str
) -> None:
    out = tmp_path / "segment.wav"
    FFmpegEngine().extract_segment(media[ext], out, CLIP_START, 5.0)
    assert _click_near(_decode(out), 96_000) == 96_000


@pytest.mark.parametrize("ext", CONTAINERS)
def test_load_mono_window_lands_on_the_window_start(media: dict[str, Path], ext: str) -> None:
    window = load_mono_window(media[ext], start_sec=CLIP_START, duration_sec=3.0, sample_rate=SR)
    assert _click_near(window, 96_000) == 96_000


@pytest.mark.parametrize("ext", CONTAINERS)
def test_decode_window_lands_on_the_start_frame(media: dict[str, Path], ext: str) -> None:
    window = FFmpegEngine().decode_window_f32(media[ext], 59_259, 3 * SR, SR, 1)[:, 0]
    assert _click_near(window, 96_000) == 96_000


@pytest.mark.parametrize("ext", CONTAINERS)
def test_seeked_window_matches_the_full_decode(media: dict[str, Path], ext: str) -> None:
    full = _decode(media[ext])
    window = load_mono_window(media[ext], start_sec=3.25, duration_sec=1.0, sample_rate=SR)
    np.testing.assert_array_equal(window, full[156_000:204_000])


def test_media_seek_prerolls_from_a_whole_second_and_trims_by_timestamp() -> None:
    seek = MediaSeek.at(3.2345678)
    assert seek.input_args(5.5) == ["-ss", "2.000000", "-t", "3.500000"]
    assert seek.output_args(1.0) == ["-ss", "1.234567", "-t", "1.000000"]
    assert seek.offset(4.0) == "2.000000"
    assert seek.first_sample(3.2345678, SR) == 155_259
    near_start = MediaSeek.at(0.4)
    assert near_start.input_args() == []
    assert near_start.output_args() == ["-ss", "0.400000"]
    assert MediaSeek.at(0.0).output_args(2.0) == ["-t", "2.000000"]


LEAD_IN_CONTAINERS = ("wav", "m4a")
LEAD_IN_SEC = 1.0
LEAD_IN_SAMPLES = 48_000
# The speech click is source sample 155 259; a segment that starts at 2.0 s (sample
# 96 000) holds it 59 259 samples in.
CLICK_AFTER_2S = SPEECH_CLICK - 2 * SR


def _render_placed(
    path: Path,
    out: Path,
    placed: list[PlacedSegment],
    *,
    lead_in_sec: float,
    duration_sec: float,
) -> np.ndarray:
    FFmpegEngine().render_timeline(
        path, out, placed, "anull", lead_in_sec=lead_in_sec, output_duration_sec=duration_sec
    )
    return _decode(out)


def _assert_silent_until(samples: np.ndarray, end: int) -> None:
    assert np.count_nonzero(samples[:end]) == 0


@pytest.mark.parametrize("ext", LEAD_IN_CONTAINERS)
def test_render_timeline_lead_in_before_a_seeked_segment_is_exact(
    media: dict[str, Path], tmp_path: Path, ext: str
) -> None:
    rendered = _render_placed(
        media[ext],
        tmp_path / "out.wav",
        [PlacedSegment(src_start=2.0, src_end=4.0)],
        lead_in_sec=LEAD_IN_SEC,
        duration_sec=4.0,
    )
    assert len(rendered) == 192_000
    _assert_silent_until(rendered, LEAD_IN_SAMPLES)
    assert _click_near(rendered, 107_259) == LEAD_IN_SAMPLES + CLICK_AFTER_2S


@pytest.mark.parametrize("ext", LEAD_IN_CONTAINERS)
def test_render_timeline_lead_in_then_gap_keeps_both_silences_exact(
    media: dict[str, Path], tmp_path: Path, ext: str
) -> None:
    rendered = _render_placed(
        media[ext],
        tmp_path / "out.wav",
        [
            PlacedSegment(src_start=2.0, src_end=2.5),
            PlacedSegment(src_start=3.0, src_end=4.0, gap_before_sec=0.25),
        ],
        lead_in_sec=LEAD_IN_SEC,
        duration_sec=3.0,
    )
    assert len(rendered) == 144_000
    _assert_silent_until(rendered, LEAD_IN_SAMPLES)
    second_segment = LEAD_IN_SAMPLES + 24_000 + 12_000  # lead-in, 0.5 s, 0.25 s gap
    assert _click_near(rendered, second_segment) == second_segment + SPEECH_CLICK - 3 * SR
    gap = rendered[LEAD_IN_SAMPLES + 24_000 : second_segment]
    assert np.count_nonzero(gap) == 0


@pytest.mark.parametrize("ext", LEAD_IN_CONTAINERS)
def test_render_timeline_lead_in_then_overlap_keeps_the_overlap_start_exact(
    media: dict[str, Path], tmp_path: Path, ext: str
) -> None:
    rendered = _render_placed(
        media[ext],
        tmp_path / "out.wav",
        [
            PlacedSegment(src_start=2.0, src_end=3.0),
            PlacedSegment(src_start=3.0, src_end=4.0, overlap_prev_sec=0.5),
        ],
        lead_in_sec=LEAD_IN_SEC,
        duration_sec=3.0,
    )
    assert len(rendered) == 144_000
    _assert_silent_until(rendered, LEAD_IN_SAMPLES)
    second_segment = LEAD_IN_SAMPLES + 24_000  # lead-in plus the first 0.5 s
    assert _click_near(rendered, second_segment) == second_segment + SPEECH_CLICK - 3 * SR


@pytest.mark.parametrize("ext", LEAD_IN_CONTAINERS)
def test_play_window_that_starts_in_a_timeline_hole_keeps_its_lead_in(
    media: dict[str, Path], tmp_path: Path, ext: str
) -> None:
    path = media[ext]
    project = EpisodeProject.create("hole", str(path.parent))
    project.tracks = [
        Track(
            id="host",
            label="Host",
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=path.name, duration_sec=6.0),
        )
    ]
    project.clips = [
        Clip(id="c", track_id="host", source_start=2.0, source_end=5.0, timeline_start=2.0)
    ]
    project.timeline.duration_sec = 5.0
    out = tmp_path / "window.wav"
    render_track_segment(project, "host", 1.0, 5.0, out, {})
    rendered = _decode(out)
    assert len(rendered) == 192_000
    _assert_silent_until(rendered, LEAD_IN_SAMPLES)
    assert _click_near(rendered, 107_259) == LEAD_IN_SAMPLES + CLICK_AFTER_2S
