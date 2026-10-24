"""room_tone._track_floor reads the batch's 16 kHz decode instead of decoding the file again."""

from __future__ import annotations

import wave
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.edits.audio_cache import recording_audio_cache
from podcast_mcp.engines import room_tone
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.room_tone import SAMPLE_RATE, track_floor
from podcast_mcp.engines.ungated_audio import load_mono_full
from podcast_mcp.util.batch_scope import batch_scope

SR = 48000


def test_slices_of_the_held_decode_give_the_one_shot_floor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    wav = _write_wav(tmp_path / "t.wav", 1)
    with batch_scope():
        load_mono_full(wav, sample_rate=SAMPLE_RATE)
        whole = room_tone._track_floor(wav, room_tone.file_revision(wav))
        room_tone._track_floor.cache_clear()
        monkeypatch.setattr(room_tone, "_HELD_CHUNK", 1000 * SAMPLE_RATE // 1000 + 7)
        sliced = room_tone._track_floor(wav, room_tone.file_revision(wav))
    assert sliced == whole


def test_a_missing_file_inside_a_batch_reads_as_it_does_outside(tmp_path: Path) -> None:
    held = _write_wav(tmp_path / "held.wav", 1)
    gone = tmp_path / "gone.wav"
    outside = room_tone._track_floor(gone, room_tone.file_revision(held))
    room_tone._track_floor.cache_clear()
    with batch_scope():
        load_mono_full(held, sample_rate=SAMPLE_RATE)
        inside = room_tone._track_floor(gone, room_tone.file_revision(held))
    assert inside == outside


def _write_wav(path: Path, channels: int) -> Path:
    rng = np.random.default_rng(7)
    seconds = 6
    t = np.arange(SR * seconds) / SR
    bed = rng.standard_normal((t.size, channels)) * 0.003
    voice = np.sin(2 * np.pi * 180 * t)[:, None] * 0.2 * ((t % 2.0) < 0.7)[:, None]
    pcm = np.round(np.clip(bed + voice, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(channels)
        f.setsampwidth(2)
        f.setframerate(SR)
        f.writeframes(pcm.tobytes())
    return path


@pytest.fixture(autouse=True)
def _fresh_floor_cache() -> Iterator[None]:
    room_tone._track_floor.cache_clear()
    yield
    room_tone._track_floor.cache_clear()


@pytest.fixture
def streams(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    seen: list[Path] = []
    real = FFmpegEngine.stream_mono_f32

    def counted(self: FFmpegEngine, path: Path, **kwargs: int):  # type: ignore[no-untyped-def]
        seen.append(path)
        return real(self, path, **kwargs)

    monkeypatch.setattr(FFmpegEngine, "stream_mono_f32", counted)
    return seen


@pytest.mark.parametrize("channels", [1, 2])
def test_the_streamed_decode_is_the_batch_waveform_byte_for_byte(
    tmp_path: Path, channels: int
) -> None:
    wav = _write_wav(tmp_path / "t.wav", channels)
    streamed = np.concatenate(list(FFmpegEngine().stream_mono_f32(wav, sample_rate=SAMPLE_RATE)))
    with batch_scope():
        waveform = recording_audio_cache(wav).waveform.samples
    assert waveform.dtype == streamed.dtype
    assert waveform.tobytes() == streamed.tobytes()
    assert np.array_equal(waveform, load_mono_full(wav, sample_rate=SAMPLE_RATE))


@pytest.mark.parametrize("channels", [1, 2])
def test_the_floor_comes_from_the_held_decode_without_a_second_decode(
    tmp_path: Path, streams: list[Path], channels: int
) -> None:
    wav = _write_wav(tmp_path / "t.wav", channels)
    alone = track_floor(wav)
    assert streams == [wav.resolve()]
    room_tone._track_floor.cache_clear()
    streams.clear()
    with batch_scope():
        recording_audio_cache(wav)
        shared = track_floor(wav)
    assert streams == []
    assert shared == alone
    assert shared.__class__.__name__ == "LiveFloor"


def test_a_file_the_batch_has_not_decoded_is_still_streamed(
    tmp_path: Path, streams: list[Path]
) -> None:
    wav = _write_wav(tmp_path / "t.wav", 1)
    with batch_scope():
        track_floor(wav)
    assert streams == [wav.resolve()]
