"""GCC-PHAT lag and bounded WAV window reads."""

from __future__ import annotations

import struct
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.align import gcc_phat_offset, gcc_phat_result, read_wav_mono_window


def _noise(n: int, *, seed: int = 0) -> np.ndarray:
    return np.random.default_rng(seed).normal(size=n)


def test_gcc_phat_offset_finds_one_sample_shift_at_8k() -> None:
    rng = np.random.default_rng(0)
    ref = rng.normal(size=8000)
    sig = np.concatenate([np.zeros(1), ref[:-1]])
    offset = gcc_phat_offset(ref, sig, 8000, max_lag_s=0.01)
    assert abs(offset - 1 / 8000) <= 0.5 / 8000
    neg = np.concatenate([ref[1:], np.zeros(1)])
    back = gcc_phat_offset(ref, neg, 8000, max_lag_s=0.01)
    assert abs(back + 1 / 8000) <= 0.5 / 8000


def test_gcc_phat_offset_finds_120ms_noise() -> None:
    sr = 8000
    ref = _noise(sr * 2)
    delay = int(0.120 * sr)
    sig = np.concatenate([np.zeros(delay), ref[:-delay]])
    offset = gcc_phat_offset(ref, sig, sr, max_lag_s=1.0)
    assert abs(offset - 0.120) < 0.002


def test_gcc_phat_offset_silence_is_zero() -> None:
    ref = np.zeros(4000)
    sig = np.zeros(4000)
    assert gcc_phat_offset(ref, sig, 8000, max_lag_s=0.05) == 0.0
    offset, confidence = gcc_phat_result(ref, sig, 8000, max_lag_s=0.05)
    assert offset is None
    assert confidence == 0.0


def test_gcc_phat_offset_rejects_short_and_bad_rate() -> None:
    ref = np.ones(4)
    assert gcc_phat_offset(ref, ref, 8000, max_lag_s=0.05) == 0.0
    assert gcc_phat_offset(np.ones(16), np.ones(16), 0, max_lag_s=0.05) == 0.0
    assert gcc_phat_offset(np.ones(16), np.ones(16), 8000, max_lag_s=0.0) == 0.0
    constant = np.full(4000, 0.5)
    offset, confidence = gcc_phat_result(constant, constant, 8000, max_lag_s=0.05)
    assert offset is None
    assert confidence == 0.0


def test_xcorr_lag_window_pads_when_lag_exceeds_length() -> None:
    from podcast_mcp.engines.align import _xcorr_lag_window

    ref = np.ones(8, dtype=np.float64)
    src = np.ones(8, dtype=np.float64)
    window, center = _xcorr_lag_window(ref, src, 20, phat=True)
    assert center == 20
    assert window.size == 41
    assert window[0] == 0.0
    assert window[-1] == 0.0


def test_gcc_phat_short_window_empty_sidelobe() -> None:
    rng = np.random.default_rng(1)
    ref = rng.normal(size=8)
    offset, confidence = gcc_phat_result(ref, ref, 8, max_lag_s=0.2)
    assert confidence >= 0.0
    assert offset is None or abs(offset) <= 0.2


def test_gcc_phat_offset_clamps_to_max_lag() -> None:
    sr = 8000
    ref = _noise(sr * 2)
    delay = int(0.4 * sr)
    sig = np.concatenate([np.zeros(delay), ref[:-delay]])
    offset = gcc_phat_offset(ref, sig, sr, max_lag_s=0.05)
    assert abs(offset) <= 0.05 + 1 / sr


def test_read_wav_mono_window_bounds_bytes(tmp_path: Path) -> None:
    sr = 8000
    seconds = 12
    path = tmp_path / "long.wav"
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        frame = struct.pack("<h", 1000)
        wf.writeframes(frame * sr * seconds)
    samples, bytes_read = read_wav_mono_window(path, start_sec=0.0, duration_sec=2.0, out_rate=8000)
    assert samples.size == sr * 2
    assert bytes_read == sr * 2 * 2
    assert bytes_read < sr * seconds * 2


def test_read_wav_mono_window_edges(tmp_path: Path) -> None:
    zero = tmp_path / "zero.wav"
    with wave.open(str(zero), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(8000)
    empty, n = read_wav_mono_window(zero, duration_sec=1.0, out_rate=8000)
    assert empty.size == 0
    assert n == 0
    samples, n = read_wav_mono_window(zero, duration_sec=0.0, out_rate=8000)
    assert samples.size == 0 and n == 0
    none_rate, n = read_wav_mono_window(zero, duration_sec=1.0, out_rate=0)
    assert none_rate.size == 0 and n == 0
    sr = 8000
    stereo = tmp_path / "stereo.wav"
    with wave.open(str(stereo), "w") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(struct.pack("<hh", 1000, 3000) * 16)
    mono, bytes_read = read_wav_mono_window(stereo, duration_sec=1.0, out_rate=4000)
    assert bytes_read == 16 * 4
    assert mono.size > 0
    eight = tmp_path / "u8.wav"
    with wave.open(str(eight), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(1)
        wf.setframerate(sr)
        wf.writeframes(bytes([128 + (i % 20) for i in range(64)]))
    u8, _n = read_wav_mono_window(eight, duration_sec=1.0, out_rate=8000)
    assert u8.size == 64
    later, later_n = read_wav_mono_window(stereo, start_sec=10.0, duration_sec=1.0, out_rate=8000)
    assert later.size == 0
    assert later_n == 0
    four = tmp_path / "i32.wav"
    with wave.open(str(four), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(4)
        wf.setframerate(sr)
        wf.writeframes(struct.pack("<i", 1000) * 32)
    i32, n32 = read_wav_mono_window(four, duration_sec=1.0, out_rate=8000)
    assert i32.size == 32
    assert n32 == 32 * 4
    packed24 = tmp_path / "i24.wav"
    with wave.open(str(packed24), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(3)
        wf.setframerate(sr)
        wf.writeframes(b"\x00\x00\x01" * 32)
    empty24, n24 = read_wav_mono_window(packed24, duration_sec=1.0, out_rate=8000)
    assert empty24.size == 0
    assert n24 == 0


def test_read_wav_mono_window_caps_and_rate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines import align as align_mod

    sr = 8000
    path = tmp_path / "long.wav"
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(struct.pack("<h", 1000) * sr)
    monkeypatch.setattr(align_mod, "_MAX_WAV_WINDOW_BYTES", 64)
    samples, bytes_read = read_wav_mono_window(path, duration_sec=1.0, out_rate=sr)
    assert bytes_read <= 64
    assert samples.size <= 32
    monkeypatch.setattr(align_mod, "_MAX_WAV_WINDOW_BYTES", 1)
    empty_cap, n_cap = read_wav_mono_window(path, duration_sec=1.0, out_rate=sr)
    assert empty_cap.size == 0
    assert n_cap == 0
    monkeypatch.setattr(align_mod, "_MAX_WAV_RATE", 1000)
    empty, n = read_wav_mono_window(path, duration_sec=1.0, out_rate=sr)
    assert empty.size == 0
    assert n == 0


def test_load_mono_window_pcm_skips_ffmpeg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from podcast_mcp.engines.align import load_mono_window

    path = tmp_path / "pcm.wav"
    with wave.open(str(path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(8000)
        wf.writeframes(struct.pack("<h", 1000) * 800)
    monkeypatch.setattr(
        "podcast_mcp.engines.align.run",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("ffmpeg")),
    )
    samples = load_mono_window(path, duration_sec=0.1, sample_rate=8000)
    assert samples.size > 0
    assert samples.dtype == np.float32
    missing, n_missing = read_wav_mono_window(
        tmp_path / "nope.wav", duration_sec=1.0, out_rate=8000
    )
    assert missing.size == 0
    assert n_missing == 0


def test_load_mono_window_falls_through_to_ffmpeg(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines.align import load_mono_window

    path = tmp_path / "clip.mp3"
    path.write_bytes(b"not a wav")
    payload = np.ones(16, dtype=np.float32).tobytes()

    class _Result:
        stdout = payload

    monkeypatch.setattr("podcast_mcp.engines.align.run", lambda *_a, **_k: _Result())
    monkeypatch.setattr("podcast_mcp.engines.align.resolve_ffmpeg", lambda: "ffmpeg")
    samples = load_mono_window(path, duration_sec=0.1, sample_rate=8000)
    assert samples.size == 16


def test_load_mono_window_ffmpeg_when_wave_raises(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.engines.align import load_mono_window

    path = tmp_path / "clip.wav"
    path.write_bytes(b"RIFF")

    class _Result:
        stdout = np.ones(8, dtype=np.float32).tobytes()

    monkeypatch.setattr(
        "podcast_mcp.engines.align.read_wav_mono_window",
        lambda *_a, **_k: (_ for _ in ()).throw(ValueError("decode")),
    )
    monkeypatch.setattr("podcast_mcp.engines.align.run", lambda *_a, **_k: _Result())
    monkeypatch.setattr("podcast_mcp.engines.align.resolve_ffmpeg", lambda: "ffmpeg")
    samples = load_mono_window(path)
    assert samples.size == 8
