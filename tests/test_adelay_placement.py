"""A delayed slice lands on sample ``ms * rate // 1000``, as the evaluation places it (#2025)."""

from __future__ import annotations

import subprocess
import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.audio import At, MixAudio, SourceAudio
from podcast_mcp.engines.ffmpeg import FFmpegEngine, _delay_filter

_IMPULSE = 16384
_IMPULSE_FRAMES = 64


def _write_wav(path: Path, samples: np.ndarray, rate: int) -> Path:
    with wave.open(str(path), "wb") as audio_file:
        audio_file.setnchannels(1)
        audio_file.setsampwidth(2)
        audio_file.setframerate(rate)
        audio_file.writeframes(samples.astype("<i2").tobytes())
    return path


def _impulse(path: Path, rate: int) -> Path:
    samples = np.zeros(_IMPULSE_FRAMES, dtype="<i2")
    samples[0] = _IMPULSE
    return _write_wav(path, samples, rate)


def _read_wav(path: Path) -> tuple[int, np.ndarray]:
    with wave.open(str(path), "rb") as audio_file:
        rate = audio_file.getframerate()
        return rate, np.frombuffer(audio_file.readframes(audio_file.getnframes()), dtype="<i2")


def _filter_impulse_frame(tmp_path: Path, rate: int, chain: str) -> tuple[int, int]:
    source = _impulse(tmp_path / "impulse.wav", rate)
    out = tmp_path / "out.wav"
    subprocess.run(
        [FFmpegEngine().ffmpeg, "-y", "-i", str(source), "-af", chain, str(out)],
        check=True,
        capture_output=True,
    )
    out_rate, samples = _read_wav(out)
    return out_rate, int(np.argmax(np.abs(samples)))


def _placed_frames(
    tmp_path: Path, rate: int, delays_ms: list[int], af_chain: str = "anull"
) -> list[int]:
    source = _impulse(tmp_path / f"impulse_{rate}.wav", rate)
    duration = _IMPULSE_FRAMES / rate
    placed = [At(ms / 1000, SourceAudio(source, 0.0, duration)) for ms in sorted(delays_ms)]
    out = tmp_path / f"placed_{rate}.wav"
    FFmpegEngine().render_timeline(out, MixAudio(placed[0], tuple(placed[1:])), af_chain)
    _, samples = _read_wav(out)
    return [int(i) for i in np.flatnonzero(samples)]


def _float32_short_ms(rate: int, count: int) -> list[int]:
    ms = np.arange(1, 20_001, dtype=np.int64)
    model = (ms.astype(np.float32) * np.float32(rate) / np.float32(1000)).astype(np.int64)
    return [int(value) for value in ms[model != ms * rate // 1000][:count]]


def test_delay_filter_places_an_impulse_on_the_exact_sample(tmp_path: Path) -> None:
    rate, frame = _filter_impulse_frame(tmp_path, 44100, _delay_filter(10.9, 44100))
    assert rate == 44100
    assert frame == 480690


def test_delay_filter_keeps_its_rate_when_a_later_filter_forces_another(tmp_path: Path) -> None:
    chain = f"{_delay_filter(1.0, 44100)},aformat=sample_rates=48000"
    rate, frame = _filter_impulse_frame(tmp_path, 44100, chain)
    assert rate == 48000
    assert abs(frame - 48000) <= 2


def test_render_keeps_the_delay_when_the_track_chain_forces_another_rate(tmp_path: Path) -> None:
    source = _impulse(tmp_path / "impulse.wav", 44100)
    placed = (
        At(0.0, SourceAudio(source, 0.0, 0.001)),
        At(1.0, SourceAudio(source, 0.0, 0.001)),
    )
    out = tmp_path / "out.wav"
    FFmpegEngine().render_timeline(
        out, MixAudio(placed[0], placed[1:]), "aformat=sample_rates=48000"
    )
    rate, samples = _read_wav(out)
    assert rate == 48000
    late = np.abs(samples[24000:])
    assert abs(24000 + int(np.argmax(late)) - 48000) <= 2


def test_render_places_a_delayed_child_at_its_own_rate_in_a_mixed_rate_mix(
    tmp_path: Path,
) -> None:
    head = _write_wav(tmp_path / "head.wav", np.zeros(4 * 44100, dtype="<i2"), 44100)
    child = _impulse(tmp_path / "child.wav", 48000)
    out = tmp_path / "out.wav"
    FFmpegEngine().render_timeline(
        out,
        MixAudio(
            At(0.0, SourceAudio(head, 0.0, 4.0)),
            (At(2.5, SourceAudio(child, 0.0, _IMPULSE_FRAMES / 48000)),),
        ),
        "anull",
    )
    rate, samples = _read_wav(out)
    expected = round(2500 * 48000 // 1000 * rate / 48000)
    assert abs(int(np.argmax(np.abs(samples))) - expected) <= 1


def test_render_places_a_long_delay_on_the_exact_sample(tmp_path: Path) -> None:
    source = _impulse(tmp_path / "impulse.wav", 48000)
    quiet = _write_wav(tmp_path / "quiet.wav", np.zeros(480, dtype="<i2"), 48000)
    out = tmp_path / "long.wav"
    FFmpegEngine().render_timeline(
        out,
        MixAudio(
            At(0.0, SourceAudio(quiet, 0.0, 0.01)),
            (At(3000.0, SourceAudio(source, 0.0, _IMPULSE_FRAMES / 48000)),),
        ),
        "anull",
    )
    chunk_frames = 1 << 22
    first = None
    with wave.open(str(out), "rb") as audio_file:
        for start in range(0, audio_file.getnframes(), chunk_frames):
            chunk = np.frombuffer(audio_file.readframes(chunk_frames), dtype="<i2")
            if np.any(chunk):
                first = start + int(np.flatnonzero(chunk)[0])
                break
    assert first == 144_000_000


@pytest.mark.parametrize("rate", [8000, 22050, 44100, 48000])
def test_render_places_every_delay_on_ms_times_rate_floor_1000(tmp_path: Path, rate: int) -> None:
    delays = [*_float32_short_ms(rate, 3), 10900, 15000]
    if rate == 44100:
        delays.append(10875)
    expected = sorted({ms * rate // 1000 for ms in delays})
    assert _placed_frames(tmp_path, rate, delays) == expected
