from __future__ import annotations

import subprocess
import wave
from pathlib import Path

import pytest

from podcast_mcp.engines.audio_audit import detect_mains_hum, measure_astats
from podcast_mcp.engines.ffmpeg import FFmpegEngine


@pytest.fixture
def hum_wav(tmp_path: Path) -> Path:
    out = tmp_path / "hum.wav"
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=60:duration=3",
        "-ar",
        "8000",
        "-ac",
        "1",
        str(out),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        pytest.skip(f"ffmpeg required: {exc}")
    return out


def test_measure_astats_returns_expected_keys(sample_wav: Path):
    stats = measure_astats(sample_wav)
    assert stats["rms_level_db"] is not None
    assert stats["peak_level_db"] is not None
    assert stats["crest_factor"] is not None
    assert stats["dc_offset"] is not None
    assert "flat_factor" in stats
    assert "dynamic_range_db" in stats


def test_measure_astats_missing_field_returns_none(sample_wav: Path, monkeypatch):
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout="", stderr="no useful data"),
    )
    stats = measure_astats(sample_wav)
    assert stats["rms_level_db"] is None
    assert stats["peak_count"] is None


def test_detect_mains_hum_positive(hum_wav: Path):
    result = detect_mains_hum(hum_wav, threshold_ratio=0.05)
    assert result["hum_detected"] is True
    assert result["dominant_frequency"] == "60hz_ratio"
    assert result["recommendation"] is not None


def test_detect_mains_hum_negative(sample_wav: Path):
    # sample_wav is a 440Hz tone, not mains hum
    result = detect_mains_hum(sample_wav, threshold_ratio=0.05)
    assert result["hum_detected"] is False
    assert result["recommendation"] is None


def test_detect_mains_hum_short_clip_returns_reason(tmp_path: Path):
    out = tmp_path / "tiny.wav"
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\x00\x00" * 100)
    result = detect_mains_hum(out)
    assert result["hum_detected"] is False
    assert "reason" in result


def test_render_spectrogram_creates_png(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    out_png = tmp_path / "spec.png"
    eng.render_spectrogram(sample_wav, out_png)
    assert out_png.is_file()
    assert out_png.stat().st_size > 0


def test_render_spectrogram_with_segment(sample_wav: Path, tmp_path: Path):
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    out_png = tmp_path / "spec_segment.png"
    eng.render_spectrogram(sample_wav, out_png, start_sec=0.0, duration_sec=1.0)
    assert out_png.is_file()
    assert not out_png.with_suffix(".segment.wav").is_file()
