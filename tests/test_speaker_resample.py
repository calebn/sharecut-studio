"""Speaker windows are low-passed before the 16 kHz resample (#2034 item 7)."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from podcast_mcp.engines.speaker_id import (
    _read_window,
    _WavWindowReader,
    enroll_segment,
    score_window,
)
from podcast_mcp.project.transcript_context import SpeakerIdConfig
from test_speaker_extended import _speaker_project

_RATE = 48000
_IN_BAND = 300.0
_ABOVE_NYQUIST = 12000.0


def _write_tones(path: Path) -> None:
    t = np.arange(int(_RATE * 2.0)) / _RATE
    wave_ = 0.25 * np.sin(2 * np.pi * _IN_BAND * t) + 0.25 * np.sin(2 * np.pi * _ABOVE_NYQUIST * t)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(_RATE)
        wf.writeframes((wave_ * 32767).astype("<i2").tobytes())


def _tone_amplitude(samples: np.ndarray, freq: float) -> float:
    t = np.arange(samples.size) / 16000.0
    basis = np.exp(-2j * np.pi * freq * t)
    return float(np.abs(np.mean(samples * basis)) * 2.0)


def _aliased_amplitude(samples: np.ndarray) -> float:
    # 12 kHz folds to 4 kHz at 16 kHz when nothing filters it first.
    return _tone_amplitude(samples, 4000.0)


class _Capture:
    def __init__(self) -> None:
        self.windows: list[np.ndarray] = []

    def name(self) -> str:
        return "capture"

    def embed(self, samples: np.ndarray, sample_rate: int) -> np.ndarray:
        self.windows.append(np.asarray(samples, dtype=np.float64))
        return np.ones(8, dtype=np.float32)


def _assert_filtered(samples: np.ndarray) -> None:
    assert samples.size > 16000 // 2
    core = samples[1600:-1600]
    assert _tone_amplitude(core, _IN_BAND) > 0.2
    assert _aliased_amplitude(core) < 0.01


def test_reader_window_drops_content_above_the_new_nyquist(tmp_path: Path) -> None:
    wav = tmp_path / "tones.wav"
    _write_tones(wav)
    reader = _WavWindowReader.open(wav)
    assert reader is not None
    try:
        _assert_filtered(_read_window(wav, 0.0, 1.5, 16000, reader))
    finally:
        reader.close()


def test_fallback_window_drops_content_above_the_new_nyquist(tmp_path: Path) -> None:
    wav = tmp_path / "tones.wav"
    _write_tones(wav)
    _assert_filtered(_read_window(wav, 0.0, 1.5, 16000, None))


def test_enroll_segment_embeds_a_filtered_window(tmp_path: Path, sample_wav: Path) -> None:
    _, project = _speaker_project(tmp_path, sample_wav)
    _write_tones(project.raw_dir() / "host.wav")
    backend = _Capture()
    cfg = SpeakerIdConfig()
    enroll_segment(project, "host-id", "host", 0.0, 1.5, cfg, backend)
    assert len(backend.windows) == 1
    _assert_filtered(backend.windows[0])


def test_score_window_embeds_a_filtered_window(tmp_path: Path, sample_wav: Path) -> None:
    _, project = _speaker_project(tmp_path, sample_wav)
    _write_tones(project.raw_dir() / "host.wav")
    backend = _Capture()
    cfg = SpeakerIdConfig()
    enroll_segment(project, "host-id", "host", 0.0, 1.5, cfg, backend)
    backend.windows.clear()
    score_window(project, "host", 0.0, 1.5, cfg, backend)
    assert len(backend.windows) == 1
    _assert_filtered(backend.windows[0])


def test_a_16_khz_source_is_read_unfiltered_with_no_margin(tmp_path: Path) -> None:
    wav = tmp_path / "native.wav"
    samples = (np.sin(2 * np.pi * 300.0 * np.arange(32000) / 16000) * 8000).astype("<i2")
    with wave.open(str(wav), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(samples.tobytes())
    reader = _WavWindowReader.open(wav)
    assert reader is not None
    reads: list[int] = []
    original = reader._wf.readframes

    def counted(n: int) -> bytes:
        reads.append(n)
        return original(n)

    reader._wf.readframes = counted
    try:
        window = reader.window(0.5, 1.0, 16000)
    finally:
        reader.close()
    assert reads == [16000]
    np.testing.assert_allclose(window, samples[8000:24000] / 32768.0, atol=1e-6)
