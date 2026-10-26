"""A file whose first audio stream starts late has one audio-relative clock (#2175).

Source time 0 is a:0's first sample, the clock every whole-file decode, ASR window and
transcript already uses. The fixture holds 8 s of video and 2 s of audio that starts 3 s
into the container.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.audio import SourceAudio
from podcast_mcp.engines.ffmpeg import FFmpegEngine

SRC_ROOT = Path(__file__).resolve().parents[1] / "src" / "podcast_mcp"
SR = 44_100
PCM_TOLERANCE = 1e-3


@pytest.fixture(scope="module")
def eng() -> FFmpegEngine:
    engine = FFmpegEngine()
    if not engine.check_available()[0]:
        pytest.skip("ffmpeg not available")
    return engine


@pytest.fixture(scope="module")
def late(eng: FFmpegEngine, tmp_path_factory: pytest.TempPathFactory) -> Path:
    path = tmp_path_factory.mktemp("late") / "late.mkv"
    subprocess.run(
        [
            eng.ffmpeg,
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=64x64:rate=10:duration=8",
            "-itsoffset",
            "3",
            "-f",
            "lavfi",
            "-i",
            f"sine=f=440:r={SR}:duration=2",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            "ffv1",
            "-c:a",
            "pcm_s16le",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path


def _whole(eng: FFmpegEngine, path: Path) -> np.ndarray:
    _, _, chunks = eng.stream_pcm_f32(path)
    return np.concatenate([c.reshape(-1) for c in chunks])


def _read(eng: FFmpegEngine, path: Path) -> np.ndarray:
    result = subprocess.run(
        [eng.ffmpeg, "-v", "error", "-i", str(path), "-ac", "1", "-f", "f32le", "pipe:1"],
        capture_output=True,
        check=True,
    )
    return np.frombuffer(result.stdout, dtype=np.float32)


def test_probe_duration_is_the_decoded_audio_length(eng: FFmpegEngine, late: Path) -> None:
    whole = _whole(eng, late)
    assert len(whole) / SR == pytest.approx(2.0, abs=0.01)
    assert eng.probe(late).duration_sec == pytest.approx(len(whole) / SR, abs=0.01)


def test_windowed_decode_is_the_slice_of_the_whole_decode(eng: FFmpegEngine, late: Path) -> None:
    whole = _whole(eng, late)
    start, frames = SR // 2, SR // 2
    window = eng.decode_window_f32(late, start, frames, SR, 1).reshape(-1)
    assert len(window) == frames
    assert np.abs(window).max() > 0.1
    np.testing.assert_allclose(window, whole[start : start + frames], atol=PCM_TOLERANCE)


def test_render_keep_window_is_the_slice_of_the_whole_decode(
    eng: FFmpegEngine, late: Path, tmp_path: Path
) -> None:
    whole = _whole(eng, late)
    out = tmp_path / "keep.wav"
    eng.render_timeline(out, SourceAudio(late, 0.5, 1.5), "anull")
    rendered = _read(eng, out)
    assert len(rendered) == SR
    assert np.abs(rendered).max() > 0.1
    np.testing.assert_allclose(rendered, whole[SR // 2 : SR // 2 + SR], atol=PCM_TOLERANCE)


def test_whole_clip_render_keeps_the_decoded_length(
    eng: FFmpegEngine, late: Path, tmp_path: Path
) -> None:
    whole = _whole(eng, late)
    out = tmp_path / "whole.wav"
    eng.render_timeline(out, SourceAudio(late, 0.0, eng.probe(late).duration_sec), "anull")
    rendered = _read(eng, out)
    assert len(rendered) == pytest.approx(len(whole), abs=SR // 100)
    np.testing.assert_allclose(rendered[: len(whole)], whole[: len(rendered)], atol=PCM_TOLERANCE)


def test_every_media_seek_names_its_lead() -> None:
    """A media read built without a lead lands late-start audio on the container clock."""
    call = re.compile(r"MediaSeek\.at\((?P<args>[^()]*(?:\([^()]*\)[^()]*)*)\)")
    missing = [
        f"{path.relative_to(SRC_ROOT).as_posix()}:{text.count(chr(10), 0, hit.start()) + 1}"
        for path in sorted(SRC_ROOT.rglob("*.py"))
        if path.name != "media_seek.py"
        for text in [path.read_text(encoding="utf-8")]
        for hit in call.finditer(text)
        if "lead_sec=" not in hit["args"]
    ]
    assert not missing, "MediaSeek.at without lead_sec:\n" + "\n".join(missing)
