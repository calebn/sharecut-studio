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
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.timeline_render import render_track_from_timeline
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
