"""The bleed gate judges own versus copy on each channel of a multichannel lane (#1094).

A stereo or ambisonic mic can carry its speaker on one channel while the peer's copy
reaches every channel. A mixdown halves that own sound against the copy, so judging
it there turned a quiet "uh-huh" down with the copy.
"""

from __future__ import annotations

import struct
import subprocess
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.engines.align import read_wav_mono_window
from podcast_mcp.engines.bleed_gate import (
    EVIDENCE_RATE,
    _channels_are_one_signal,
    _lane_signals,
    build_bleed_gate_plan,
)
from podcast_mcp.engines.ungated_audio import load_wav_channels_window, raw_timeline_samples
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.binaries import resolve_ffmpeg
from test_bleed_attenuation import _gated_over, _silent, _talking_over, _unchanged
from test_bleed_gate_regression import RATE, _read_pcm, _write_pcm
from test_wav_util import extensible_wav

QUIET_UH_HUH = ("uh-huh", 5.0, 5.3, -10.0)
DUAL_MONO_SPANS = ((0.88, 4.89), (5.52, 11.89), (12.97, 30.790000000000003))
DUAL_MONO_PROTECTED = ((0.11, 0.8), (4.93, 5.4399999999999995), (11.93, 12.89))


@pytest.mark.parametrize(
    "channel_copy_db",
    [
        pytest.param((0.0, 0.0), id="stereo-same-copy-on-both"),
        pytest.param((0.0, -4.0), id="stereo-quieter-copy-on-the-right"),
        pytest.param((0.0, -3.0, -6.0, 2.0), id="four-channels"),
        pytest.param((2.0, 0.0, -3.0, -6.0), id="four-channels-loudest-copy-on-the-own-channel"),
        pytest.param((-np.inf, 0.0), id="stereo-own-channel-the-copy-never-reaches"),
    ],
)
def test_own_sound_on_one_channel_is_untouched(
    tmp_path: Path, channel_copy_db: tuple[float, ...]
) -> None:
    project = _talking_over(tmp_path, own=(QUIET_UH_HUH,), channel_copy_db=channel_copy_db)
    before, after = _gated_over(project, tmp_path)
    assert after.shape == (round(32.0 * 48_000), len(channel_copy_db))
    _unchanged(before, after, 5.0, 5.3)
    _silent(after, 1.05, 3.95)
    _silent(after, 7.45, 10.55)


@pytest.mark.parametrize(
    "channel_copy_db",
    [
        pytest.param((0.0, -4.0), id="stereo"),
        pytest.param((0.0, -3.0, -6.0, 2.0), id="four-channels"),
    ],
)
def test_copy_on_every_channel_is_turned_down(
    tmp_path: Path, channel_copy_db: tuple[float, ...]
) -> None:
    project = _talking_over(tmp_path, channel_copy_db=channel_copy_db)
    _, after = _gated_over(project, tmp_path)
    _silent(after, 1.05, 30.65)


def test_dual_mono_lane_is_judged_once_on_its_mixdown(tmp_path: Path) -> None:
    """The same signal on both channels: the plan main made, pinned before #1094."""
    project = _talking_over(tmp_path, own=(QUIET_UH_HUH, ("laugh", 12.0, 12.8, -1.0)))
    host = tmp_path / "raw" / "host.wav"
    mono = _read_pcm(host).astype(np.float64) / 32767
    _write_pcm(host, np.column_stack([mono, mono]))
    plan = build_bleed_gate_plan(project, "host")
    assert plan.attenuation_spans == DUAL_MONO_SPANS
    assert plan.protected_spans == DUAL_MONO_PROTECTED
    assert (plan.reduction, plan.bed_db, plan.reasons) == ("mute", -90.0, ())


def _tag_layout(path: Path, mask: int, own_channel: int) -> None:
    """Rewrite the lane as a WAVE_FORMAT_EXTENSIBLE file tagged with a channel mask.

    The own sound starts on the first channel; it is swapped onto ``own_channel``.
    """
    samples = _read_pcm(path).copy()
    samples[:, [0, own_channel]] = samples[:, [own_channel, 0]]
    channels = samples.shape[1]
    pcm_guid = bytes.fromhex("0100000000001000800000aa00389b71")
    fmt = struct.pack(
        "<HHIIHHHHI16s",
        0xFFFE,
        channels,
        RATE,
        RATE * channels * 2,
        channels * 2,
        16,
        22,
        16,
        mask,
        pcm_guid,
    )
    data = samples.astype("<i2").tobytes()
    body = (
        b"WAVE"
        + b"fmt "
        + struct.pack("<I", len(fmt))
        + fmt
        + b"data"
        + struct.pack("<I", len(data))
    )
    path.write_bytes(b"RIFF" + struct.pack("<I", len(body) + len(data)) + body + data)


@pytest.mark.parametrize(
    ("layout", "mask", "copy_db", "own_channel"),
    [
        pytest.param("quad", 0x33, (0.0, -3.0, -6.0, 2.0), 1, id="quad-front-right"),
        pytest.param("quad", 0x33, (0.0, -3.0, -6.0, 2.0), 2, id="quad-back-left"),
        pytest.param("quad", 0x33, (0.0, -3.0, -6.0, 2.0), 3, id="quad-back-right"),
        pytest.param("3.0(back)", 0x103, (0.0, -3.0, -6.0), 2, id="back-centre"),
        pytest.param("5.1", 0x3F, (0.0, -2.0, -4.0, -6.0, -3.0, -1.0), 4, id="5.1-surround-left"),
        pytest.param("stereo", 0x3, (0.0, -4.0), 1, id="stereo-right"),
    ],
)
def test_own_sound_on_any_channel_of_a_tagged_layout_is_untouched(
    tmp_path: Path, layout: str, mask: int, copy_db: tuple[float, ...], own_channel: int
) -> None:
    """ffmpeg remixes a decode to the default layout for the channel count; the gate must not."""
    project = _talking_over(tmp_path, own=(QUIET_UH_HUH,), channel_copy_db=copy_db)
    _tag_layout(tmp_path / "raw" / "host.wav", mask, own_channel)
    before, after = _gated_over(project, tmp_path)
    assert after.shape == (round(32.0 * 48_000), len(copy_db)), layout
    _unchanged(before, after, 5.0, 5.3)
    _silent(after, 1.05, 3.95)
    _silent(after, 7.45, 10.55)


def _encode(project: EpisodeProject, tmp_path: Path, codec_args: list[str], suffix: str) -> None:
    """Re-encode the lane's WAV with a lossy codec and point the host track at it."""
    source = tmp_path / "raw" / "host.wav"
    lossy = source.with_suffix(suffix)
    subprocess.run(
        [resolve_ffmpeg(), "-v", "error", "-y", "-i", str(source), *codec_args, str(lossy)],
        check=True,
    )
    project.track_by_id("host").media.path = f"raw/host{suffix}"


def _dual_mono(tmp_path: Path) -> None:
    host = tmp_path / "raw" / "host.wav"
    mono = _read_pcm(host).astype(np.float64) / 32767
    _write_pcm(host, np.column_stack([mono, mono]))


@pytest.mark.parametrize(
    "codec_args",
    [
        pytest.param(["-c:a", "aac", "-b:a", "64k"], id="aac-64k"),
        pytest.param(["-c:a", "aac", "-b:a", "128k"], id="aac-128k"),
    ],
)
def test_lossy_dual_mono_is_judged_once_like_wav_dual_mono(
    tmp_path: Path, codec_args: list[str]
) -> None:
    """A codec decodes the two copies of one channel a little apart; they are still one signal."""
    project = _talking_over(tmp_path, own=(QUIET_UH_HUH,), room_floor_db=-70.0)
    _dual_mono(tmp_path)
    _encode(project, tmp_path, codec_args, ".m4a")
    channels = raw_timeline_samples(
        project, "host", sample_rate=EVIDENCE_RATE, preserve_channels=True
    )
    assert channels.shape[1] == 2
    assert not np.array_equal(channels[:, 0], channels[:, 1])
    signals = _lane_signals(project, "host")
    assert len(signals) == 1
    np.testing.assert_allclose(
        signals[0],
        raw_timeline_samples(project, "host", sample_rate=EVIDENCE_RATE),
        atol=1e-6,
    )
    assert any(
        start <= 5.0 and end >= 5.3
        for start, end in build_bleed_gate_plan(project, "host").protected_spans
    )


def test_lossy_stereo_with_own_sound_on_one_channel_is_judged_per_channel(tmp_path: Path) -> None:
    project = _talking_over(tmp_path, own=(QUIET_UH_HUH,), channel_copy_db=(0.0, -4.0))
    _encode(project, tmp_path, ["-c:a", "aac", "-b:a", "128k"], ".m4a")
    assert len(_lane_signals(project, "host")) == 2


def _speech_in_a_quiet_room(seconds: int = 60) -> np.ndarray:
    """A noise floor with half-second bursts of louder sound every 3 s, one signal."""
    rng = np.random.default_rng(7)
    room = rng.standard_normal(EVIDENCE_RATE * seconds).astype(np.float32) * 0.002
    burst = np.zeros(room.size, dtype=bool)
    for start in range(1, seconds - 2, 3):
        burst[start * EVIDENCE_RATE : round((start + 0.5) * EVIDENCE_RATE)] = True
    return room + burst * rng.standard_normal(room.size).astype(np.float32) * 0.1


def test_a_short_sound_on_one_channel_is_not_one_signal() -> None:
    voice = _speech_in_a_quiet_room()
    channels = np.column_stack([voice, voice])
    assert _channels_are_one_signal(channels)
    uh_huh = slice(round(21.5 * EVIDENCE_RATE), round(21.56 * EVIDENCE_RATE))
    channels[uh_huh, 0] += (
        np.random.default_rng(3).standard_normal(uh_huh.stop - uh_huh.start) * 0.05
    )
    assert not _channels_are_one_signal(channels)


def test_codec_noise_far_under_the_signal_is_one_signal() -> None:
    voice = _speech_in_a_quiet_room()
    jitter = 1 + 0.03 * np.random.default_rng(5).standard_normal(voice.size).astype(np.float32)
    assert _channels_are_one_signal(np.column_stack([voice, voice * jitter]))


@pytest.mark.parametrize(
    ("layout", "mask", "channels"),
    [
        pytest.param("stereo", 0x3, 2, id="stereo"),
        pytest.param("2.1", 0x7, 3, id="2.1"),
        pytest.param("5.1", 0x3F, 6, id="5.1"),
        pytest.param("quad", 0x33, 4, id="quad"),
    ],
)
def test_identical_channels_are_judged_at_ffmpegs_mono_level(
    tmp_path: Path, layout: str, mask: int, channels: int
) -> None:
    """The gate's absolute floors were set on ffmpeg's mono decode, whatever the layout's matrix."""
    project = _talking_over(tmp_path, own=(QUIET_UH_HUH,))
    host = tmp_path / "raw" / "host.wav"
    mono = _read_pcm(host).astype(np.float64) / 32767
    _write_pcm(host, np.column_stack([mono] * channels))
    _tag_layout(host, mask, 0)
    (signal,) = _lane_signals(project, "host")
    decoded = subprocess.run(
        [
            resolve_ffmpeg(),
            "-v",
            "error",
            "-i",
            str(host),
            "-ac",
            "1",
            "-ar",
            str(EVIDENCE_RATE),
            "-f",
            "f32le",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    ).stdout
    np.testing.assert_array_equal(signal, np.frombuffer(decoded, dtype=np.float32))


def _gated_speech(seed: int, seconds: int = 40) -> np.ndarray:
    """Voiced bursts of varying length and level over digital silence, like a call app's lane."""
    rng = np.random.default_rng(seed)
    clock = np.arange(RATE * seconds) / RATE
    lane = np.zeros(clock.size, dtype=np.float32)
    start = 1.0
    while start < seconds - 2:
        length = rng.uniform(0.15, 1.5)
        level = 10 ** (rng.uniform(-40, -12) / 20)
        first, last = round(start * RATE), round((start + length) * RATE)
        envelope = np.hanning(last - first) ** 0.5
        pitch = rng.uniform(90, 250)
        voice = sum(
            np.sin(2 * np.pi * pitch * harmonic * clock[first:last] + harmonic) / harmonic
            for harmonic in range(1, 12)
        )
        voice = voice + 0.3 * rng.standard_normal(last - first)
        lane[first:last] += (voice * envelope * level / np.std(voice)).astype(np.float32)
        start += length + rng.uniform(0.1, 1.0)
    return lane


def _silent_gap(lane: np.ndarray, after_sec: float = 5.0, length_sec: float = 0.5) -> int:
    """First sample at or after ``after_sec`` that starts ``length_sec`` of digital silence."""
    width = round(length_sec * RATE)
    for first in range(round(after_sec * RATE), lane.size - width, RATE // 100):
        if not lane[first : first + width].any():
            return first
    raise AssertionError("the lane has no silent gap")


def _decoded_channels(
    tmp_path: Path, channels: np.ndarray, codec_args: list[str], suffix: str
) -> np.ndarray:
    """The lane encoded with ``codec_args`` and decoded as the gate reads it, per channel."""
    source = tmp_path / "lane.wav"
    _write_pcm(source, channels)
    lossy = source.with_suffix(suffix)
    ffmpeg = resolve_ffmpeg()
    subprocess.run(
        [ffmpeg, "-v", "error", "-y", "-i", str(source), *codec_args, str(lossy)], check=True
    )
    decoded = subprocess.run(
        [
            ffmpeg,
            "-v",
            "error",
            "-i",
            str(lossy),
            "-ar",
            str(EVIDENCE_RATE),
            "-f",
            "f32le",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(decoded, dtype=np.float32).reshape(-1, channels.shape[1])


LOSSY_CODECS = [
    pytest.param(["-c:a", "libopus", "-b:a", "32k"], ".opus", id="opus-32k"),
    pytest.param(["-c:a", "libopus", "-b:a", "64k"], ".opus", id="opus-64k"),
    pytest.param(["-c:a", "libopus", "-b:a", "128k"], ".opus", id="opus-128k"),
    pytest.param(["-c:a", "aac", "-b:a", "64k"], ".m4a", id="aac-64k"),
    pytest.param(["-c:a", "aac", "-b:a", "128k"], ".m4a", id="aac-128k"),
]
# A codec spreads its quantisation noise over its transform block, so the 20 ms frames at
# the edge of a burst read the loud block's noise against their own, quieter level (#1159).
# Seed 5 reads as two signals at Opus 32k and 64k, seed 4 at Opus 32k, 64k and 128k.
CODEC_NOISE_SEEDS = (4, 5)


@pytest.mark.parametrize("seed", CODEC_NOISE_SEEDS)
@pytest.mark.parametrize(("codec_args", "suffix"), LOSSY_CODECS)
def test_codec_noise_at_the_edge_of_a_sound_is_one_signal(
    tmp_path: Path, codec_args: list[str], suffix: str, seed: int
) -> None:
    voice = _gated_speech(seed)
    decoded = _decoded_channels(tmp_path, np.column_stack([voice, voice]), codec_args, suffix)
    assert not np.array_equal(decoded[:, 0], decoded[:, 1])
    assert _channels_are_one_signal(decoded)


@pytest.mark.parametrize(("codec_args", "suffix"), LOSSY_CODECS)
def test_lossy_stereo_with_a_short_sound_on_one_channel_is_two_signals(
    tmp_path: Path, codec_args: list[str], suffix: str
) -> None:
    """A 60 ms sound at speech level in a gap is on one channel only; no codec hides it."""
    voice = _gated_speech(CODEC_NOISE_SEEDS[-1])
    left = voice.copy()
    first = _silent_gap(voice)
    burst = np.random.default_rng(3).standard_normal(round(0.06 * RATE)) * 0.05
    left[first : first + burst.size] += burst.astype(np.float32)
    decoded = _decoded_channels(tmp_path, np.column_stack([left, voice]), codec_args, suffix)
    assert not _channels_are_one_signal(decoded)


@pytest.mark.parametrize(("codec_args", "suffix"), LOSSY_CODECS)
def test_lossy_stereo_with_a_second_voice_on_one_channel_is_two_signals(
    tmp_path: Path, codec_args: list[str], suffix: str
) -> None:
    left = _gated_speech(CODEC_NOISE_SEEDS[-1])
    right = left.copy()
    first = _silent_gap(left, after_sec=10.0, length_sec=0.9)
    own = np.random.default_rng(4).standard_normal(round(0.8 * RATE)) * 0.05
    left[first : first + own.size] += own.astype(np.float32)
    decoded = _decoded_channels(tmp_path, np.column_stack([left, right]), codec_args, suffix)
    assert not _channels_are_one_signal(decoded)


def test_channel_window_reads_an_extensible_wav_like_plain_pcm(tmp_path: Path) -> None:
    """ffmpeg and most recorders write EXTENSIBLE; Python 3.11's wave alone rejects it (#1183)."""
    frames = (np.arange(-2400, 2400, dtype=np.int16).reshape(-1, 2) * 10).astype(np.int16)
    plain, tagged = tmp_path / "plain.wav", tmp_path / "tagged.wav"
    _write_pcm(plain, frames / 32767)
    tagged.write_bytes(extensible_wav(frames, rate=RATE, mask=0x3))
    window = dict(start_sec=0.01, duration_sec=0.02, sample_rate=RATE)
    expected = load_wav_channels_window(plain, **window)
    np.testing.assert_array_equal(load_wav_channels_window(tagged, **window), expected)
    assert expected.shape == (round(0.02 * RATE), 2) and expected.dtype == np.float32


def test_mono_window_reads_extensible_24_bit_multichannel_without_ffmpeg(tmp_path: Path) -> None:
    frames = (np.arange(-300, 300, dtype=np.int32).reshape(-1, 3) * 20_000).astype(np.int32)
    path = tmp_path / "three.wav"
    path.write_bytes(extensible_wav(frames, rate=RATE, width=3, mask=0x7))
    samples, bytes_read = read_wav_mono_window(path, duration_sec=1.0, out_rate=RATE)
    assert bytes_read == frames.size * 3
    np.testing.assert_allclose(samples, frames.mean(axis=1) / 8_388_608, atol=1e-9)
