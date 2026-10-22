"""A delayed slice lands on sample ``ms * rate // 1000``, as the evaluation places it (#2025)."""

from __future__ import annotations

import subprocess
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest

from podcast_mcp.engines import ffmpeg as ff
from podcast_mcp.engines import render_clock
from podcast_mcp.engines.audio import (
    At,
    Audio,
    CrossfadeAudio,
    MixAudio,
    SequenceAudio,
    SourceAudio,
    rendered_sources,
)
from podcast_mcp.engines.ffmpeg import FFmpegEngine, _delay_filter
from podcast_mcp.util.coded_error import CodedValueError

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


def _placed_frames(tmp_path: Path, rate: int, delays_ms: list[int]) -> list[int]:
    source = _impulse(tmp_path / f"impulse_{rate}.wav", rate)
    duration = _IMPULSE_FRAMES / rate
    placed = [At(ms / 1000, SourceAudio(source, 0.0, duration)) for ms in sorted(delays_ms)]
    out = tmp_path / f"placed_{rate}.wav"
    FFmpegEngine().render_timeline(out, MixAudio(placed[0], tuple(placed[1:])), "anull")
    _, samples = _read_wav(out)
    return [int(i) for i in np.flatnonzero(samples)]


# First ms values where adelay's float32 multiply lands a sample early (checked against FFmpeg 9).
_FLOAT32_SHORT_MS = {8000: [], 22050: [6100, 6180, 6260], 44100: [3050, 3090, 3130], 48000: []}


def test_delay_filter_places_an_impulse_on_the_exact_sample(tmp_path: Path) -> None:
    rate, frame = _filter_impulse_frame(tmp_path, 44100, _delay_filter(10.9, 44100))
    assert rate == 44100
    assert frame == 480690
    rate, frame = _filter_impulse_frame(tmp_path, 44100, _delay_filter(10.875, 44100))
    assert frame == 479587


def _zeros(path: Path, rate: int, seconds: float) -> SourceAudio:
    _write_wav(path, np.zeros(int(seconds * rate), dtype="<i2"), rate)
    return SourceAudio(path, 0.0, seconds)


def _impulse_at(path: Path, rate: int) -> SourceAudio:
    samples = np.zeros(rate // 2, dtype="<i2")
    samples[0] = _IMPULSE
    _write_wav(path, samples, rate)
    return SourceAudio(path, 0.0, 0.5)


def _peak_near(samples: np.ndarray, frame: int) -> int:
    window = np.abs(samples[frame - 50 : frame + 50])
    return frame - 50 + int(np.argmax(window))


def _delayed(tmp_path: Path, head_rate: int, delayed: list[tuple[int, float]]) -> Audio:
    head = _zeros(tmp_path / "head.wav", head_rate, 4.0)
    placed = tuple(
        At(start, _impulse_at(tmp_path / f"delayed_{rate}_{k}.wav", rate))
        for k, (rate, start) in enumerate(delayed)
    )
    return MixAudio(At(0.0, head), placed)


def _all_delayed(tmp_path: Path) -> Audio:
    return MixAudio(
        At(0.5, _impulse_at(tmp_path / "a44.wav", 44100)),
        (At(2.5, _impulse_at(tmp_path / "a48.wav", 48000)),),
    )


def _noise(path: Path, rate: int, seconds: float) -> Path:
    rng = np.random.default_rng(rate)
    return _write_wav(path, rng.integers(-3000, 3000, int(seconds * rate)), rate)


def _room_tone(tmp_path: Path, bed_rate: int) -> tuple[Audio, Path]:
    main = _noise(tmp_path / "main.wav", 48000, 6.0)
    bed = _noise(tmp_path / "bed.wav", bed_rate, 0.5)
    fill = SourceAudio(bed, 0.0, 0.4, is_fill=True)
    body = SequenceAudio(
        SourceAudio(main, 0.0, 2.0),
        (
            MixAudio(At(0.0, SourceAudio(main, 2.0, 4.0)), (At(0.5, fill),)),
            SourceAudio(main, 4.0, 6.0),
        ),
    )
    return MixAudio(At(0.0, body), ()), main


def _nested(tmp_path: Path, shape: str) -> Audio:
    if shape == "seq_44_mix_48":
        outer, inner, delayed_rate = 44100, 48000, 48000
    elif shape == "seq_48_mix_44":
        outer, inner, delayed_rate = 48000, 44100, 48000
    else:
        outer, inner, delayed_rate = 44100, 48000, 16000
    front = _zeros(tmp_path / "front.wav", outer, 1.0)
    inner_head = _zeros(tmp_path / "inner.wav", inner, 1.0)
    mix = MixAudio(
        At(0.0, inner_head), (At(0.5, _impulse_at(tmp_path / "late.wav", delayed_rate)),)
    )
    if shape == "xf_44_mix_16":
        return CrossfadeAudio(front, mix, 0.02)
    return SequenceAudio(front, (mix,))


_TRUNK_RATE_CASES = {
    "h44.1+d48": (lambda p: _delayed(p, 44100, [(48000, 2.5)]), 44100, [110250]),
    "h48+d44.1": (lambda p: _delayed(p, 48000, [(44100, 3.05)]), 48000, [146400]),
    "h48+d16": (lambda p: _delayed(p, 48000, [(16000, 3.05)]), 48000, [146400]),
    "h16+d48": (lambda p: _delayed(p, 16000, [(48000, 3.05)]), 16000, [48800]),
    "h44.1+d22.05+d48": (
        lambda p: _delayed(p, 44100, [(22050, 1.0009), (48000, 2.5)]),
        44100,
        [44144, 110250],
    ),
    "all-delayed": (_all_delayed, 44100, [22050, 110250]),
}


@pytest.mark.parametrize("name", list(_TRUNK_RATE_CASES))
def test_render_keeps_the_rate_the_mix_ran_at_and_places_each_delay_exactly(
    tmp_path: Path, name: str
) -> None:
    build, expected_rate, expected_frames = _TRUNK_RATE_CASES[name]
    out = tmp_path / "out.wav"
    FFmpegEngine().render_timeline(out, build(tmp_path), "anull")
    rate, samples = _read_wav(out)
    assert rate == expected_rate
    assert [_peak_near(samples, frame) for frame in expected_frames] == expected_frames


@pytest.mark.parametrize("bed_rate", [16000, 44100])
def test_room_tone_fill_leaves_the_main_lane_unresampled(tmp_path: Path, bed_rate: int) -> None:
    audio, main = _room_tone(tmp_path, bed_rate)
    out = tmp_path / "out.wav"
    FFmpegEngine().render_timeline(out, audio, "anull")
    rate, samples = _read_wav(out)
    assert (rate, len(samples)) == (48000, 288000)
    np.testing.assert_array_equal(samples[:48000], _read_wav(main)[1][:48000])


@pytest.mark.parametrize(
    ("shape", "expected_rate"),
    [("seq_44_mix_48", 44100), ("seq_48_mix_44", 48000), ("xf_44_mix_16", 44100)],
)
def test_render_keeps_a_nested_mixes_rate(tmp_path: Path, shape: str, expected_rate: int) -> None:
    out = tmp_path / "out.wav"
    FFmpegEngine().render_timeline(out, _nested(tmp_path, shape), "anull")
    assert _read_wav(out)[0] == expected_rate


_FORCED_MS = [1000, 3050, 3090, 3130, 10900, 10875, 15000, 123457, 360100]


@pytest.mark.parametrize("ms", _FORCED_MS)
def test_render_places_a_44k_source_on_the_forced_48k_output_exactly(
    tmp_path: Path, ms: int
) -> None:
    audio = MixAudio(
        At(0.0, _zeros(tmp_path / "quiet.wav", 44100, 0.2)),
        (At(ms / 1000, _impulse_at(tmp_path / "impulse.wav", 44100)),),
    )
    expected = ms * 48000 // 1000
    out = tmp_path / "out.wav"
    FFmpegEngine().render_timeline(
        out,
        audio,
        f"aformat=sample_rates=48000,atrim=start_sample={expected - 1000}:end_sample={expected + 1000}",
    )
    rate, samples = _read_wav(out)
    assert rate == 48000
    assert int(np.argmax(np.abs(samples))) == 1000


def test_render_pins_the_forced_rate_not_the_source_rate(tmp_path: Path) -> None:
    audio = MixAudio(
        At(0.0, _zeros(tmp_path / "quiet.wav", 44100, 0.2)),
        (At(3.05, _impulse_at(tmp_path / "impulse.wav", 44100)),),
    )
    commands: list[str] = []
    real_run = ff.run

    def capture_run(cmd, *args, **kwargs):
        commands.append(" ".join(str(x) for x in cmd))
        return real_run(cmd, *args, **kwargs)

    with patch.object(ff, "run", side_effect=capture_run):
        FFmpegEngine().render_timeline(tmp_path / "out.wav", audio, "aformat=sample_rates=48000")
    assert any(
        "aformat=sample_rates=48000,adelay=delays=146400S" in command for command in commands
    )


def test_render_places_a_long_delay_on_the_exact_sample(tmp_path: Path) -> None:
    audio = MixAudio(
        At(0.0, _zeros(tmp_path / "quiet.wav", 48000, 0.01)),
        (At(3000.0, _impulse_at(tmp_path / "impulse.wav", 48000)),),
    )
    out = tmp_path / "long.wav"
    FFmpegEngine().render_timeline(out, audio, "atrim=start_sample=143999000:end_sample=144001000")
    assert int(np.argmax(np.abs(_read_wav(out)[1]))) == 1000


def _clocked(tmp_path: Path, audio: Audio, chain: str) -> tuple[int, np.ndarray, list[int]]:
    out = tmp_path / "clocked.wav"
    clock_path = tmp_path / "clock.json"
    FFmpegEngine().render_timeline(out, audio, chain, clock_path=clock_path)
    rate, samples = _read_wav(out)
    clock = render_clock.read_render_clock(clock_path)
    assert clock.output.sample_rate == rate
    assert {boundary.producer.sample_rate for _, _, boundary in clock.delays} == {rate}
    rendered = rendered_sources(audio, clock)
    return (
        rate,
        samples,
        [
            source.frame(source.source_first_frame)
            for source in rendered
            if np.any(_read_wav(source.source.path)[1])
        ],
    )


@pytest.mark.parametrize("name", ["h44.1+d48", "h48+d44.1", "all-delayed"])
def test_clock_follows_the_pinned_delay(tmp_path: Path, name: str) -> None:
    build, expected_rate, expected_frames = _TRUNK_RATE_CASES[name]
    rate, samples, frames = _clocked(tmp_path, build(tmp_path), "anull")
    assert rate == expected_rate
    assert frames[-1] == _peak_near(samples, expected_frames[-1])


@pytest.mark.parametrize("shape", ["seq_44_mix_48", "seq_48_mix_44"])
def test_clock_follows_a_nested_mixes_delay(tmp_path: Path, shape: str) -> None:
    rate, samples, frames = _clocked(tmp_path, _nested(tmp_path, shape), "anull")
    assert frames == [_peak_near(samples, frames[0])]
    assert rate == (44100 if shape == "seq_44_mix_48" else 48000)


def test_clock_follows_the_room_tone_fill(tmp_path: Path) -> None:
    audio, _ = _room_tone(tmp_path, 16000)
    out = tmp_path / "out.wav"
    clock_path = tmp_path / "clock.json"
    FFmpegEngine().render_timeline(out, audio, "anull", clock_path=clock_path)
    clock = render_clock.read_render_clock(clock_path)
    assert {boundary.producer.sample_rate for _, _, boundary in clock.delays} == {48000}
    rendered_sources(audio, clock)


def test_clock_follows_the_forced_rate_delay(tmp_path: Path) -> None:
    audio = MixAudio(
        At(0.0, _zeros(tmp_path / "quiet.wav", 44100, 0.2)),
        (At(3.05, _impulse_at(tmp_path / "delayed.wav", 44100)),),
    )
    rate, samples, frames = _clocked(tmp_path, audio, "aformat=sample_rates=48000")
    assert rate == 48000
    assert frames == [146400] == [_peak_near(samples, 146400)]


def test_negotiated_rates_refuses_a_missing_port(tmp_path: Path) -> None:
    engine = FFmpegEngine()
    source = _impulse(tmp_path / "impulse.wav", 48000)
    filters = ["[0:a]adelay@pin_0=1000:all=1[out]"]
    rates = render_clock.negotiated_rates(
        engine.ffmpeg, engine.ffprobe, filters, (source,), ["adelay@pin_0"]
    )
    assert rates == {"adelay@pin_0": 48000}
    with pytest.raises(CodedValueError) as error:
        render_clock.negotiated_rates(
            engine.ffmpeg, engine.ffprobe, filters, (source,), ["adelay@pin_1"]
        )
    assert error.value.code == "render_rate_unresolved"


@pytest.mark.parametrize("rate", [8000, 22050, 44100, 48000])
def test_render_places_every_delay_on_ms_times_rate_floor_1000(tmp_path: Path, rate: int) -> None:
    delays = [*_FLOAT32_SHORT_MS[rate], 10900, 15000]
    expected = sorted({ms * rate // 1000 for ms in delays})
    assert _placed_frames(tmp_path, rate, delays) == expected
