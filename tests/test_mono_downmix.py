from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.mono_downmix import channel_mean_pan_filter, ffmpeg_mono_mean_layout
from podcast_mcp.engines.ungated_audio import load_mono_full
from podcast_mcp.util.binaries import FFmpegPairResolutionError, resolve_ffmpeg_pair


def test_channel_mean_pan_filter_stereo() -> None:
    assert channel_mean_pan_filter(2) == "pan=mono|c0=0.5*c0+0.5*c1"


def test_channel_mean_pan_filter_mono() -> None:
    assert channel_mean_pan_filter(1) == "pan=mono|c0=c0"


def _write_dual_mono_wav(path: Path, rate: int = 8000) -> None:
    n = rate
    t = np.linspace(0, 1, n, endpoint=False)
    sig = (0.25 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    stereo = np.column_stack([sig, sig])
    with wave.open(str(path), "w") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        pcm = (stereo * 32767).astype(np.int16)
        w.writeframes(pcm.tobytes())


def test_ffmpeg_mono_mean_layout_stereo_wav(tmp_path: Path) -> None:
    path = tmp_path / "dual.wav"
    _write_dual_mono_wav(path)
    assert ffmpeg_mono_mean_layout(path) == ["-af", "pan=mono|c0=0.5*c0+0.5*c1"]


def test_dual_mono_cached_decode_matches_wav_window(tmp_path: Path) -> None:
    try:
        resolve_ffmpeg_pair()
    except FFmpegPairResolutionError:
        pytest.skip("ffmpeg pair not available")
    path = tmp_path / "dual.wav"
    _write_dual_mono_wav(path)
    rate = 8000
    window = load_mono_window(path, start_sec=0.1, duration_sec=0.2, sample_rate=rate)
    full = load_mono_full(path, sample_rate=rate)
    s0, s1 = int(0.1 * rate), int(0.3 * rate)
    w_rms = float(np.sqrt(np.mean(window**2)))
    c_rms = float(np.sqrt(np.mean(full[s0:s1] ** 2)))
    if w_rms == 0:
        pytest.fail("empty window")
    diff_db = 20 * np.log10(c_rms / w_rms)
    assert abs(diff_db) < 0.05
