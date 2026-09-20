from __future__ import annotations

from pathlib import Path

import pytest

from podcast_mcp.engines.ffmpeg import FFmpegEngine


@pytest.fixture
def two_wavs(sample_wav: Path, tmp_path: Path) -> tuple[Path, Path]:
    eng = FFmpegEngine()
    ok, _ = eng.check_available()
    if not ok:
        pytest.skip("ffmpeg not available")
    a = tmp_path / "a.wav"
    b = tmp_path / "b.wav"
    eng.apply_gain(sample_wav, a, 0)
    eng.apply_gain(sample_wav, b, -6)
    return a, b


def test_mix_tracks(two_wavs: tuple[Path, Path], tmp_path: Path):
    a, b = two_wavs
    eng = FFmpegEngine()
    out = tmp_path / "mix.wav"
    eng.mix_tracks([(a, 0.0), (b, -3.0)], out)
    assert out.is_file()
    assert eng.probe(out).duration_sec > 0.5


def test_master_and_mp3(two_wavs: tuple[Path, Path], tmp_path: Path):
    a, _ = two_wavs
    eng = FFmpegEngine()
    mastered = tmp_path / "master.wav"
    eng.master_loudnorm(a, mastered, integrated_lufs=-16, true_peak_db=-1.5)
    mp3 = tmp_path / "out.mp3"
    eng.export_mp3(mastered, mp3, bitrate_kbps=128)
    assert mp3.is_file() and mp3.stat().st_size > 100


def test_mix_tracks_multi(two_wavs: tuple[Path, Path], tmp_path: Path):
    a, b = two_wavs
    eng = FFmpegEngine()
    out = tmp_path / "mix2.wav"
    eng.mix_tracks([(a, 0.0), (b, -6.0)], out)
    assert out.is_file()
    probe = eng.probe(out)
    assert probe.channels >= 1


def test_export_audio_wav_copy(two_wavs: tuple[Path, Path], tmp_path: Path):
    a, _ = two_wavs
    eng = FFmpegEngine()
    out = tmp_path / "copy.wav"
    eng.export_audio(a, out, codec="pcm_s16le")
    assert out.is_file() and out.stat().st_size > 100
