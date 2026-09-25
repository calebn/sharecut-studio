from __future__ import annotations

import logging
import os
import secrets
import shutil
import struct
import threading
import time
import wave
from pathlib import Path
from typing import ClassVar
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from podcast_mcp.engines import waveform_pyramid as wp
from podcast_mcp.engines.ffmpeg import (
    PCM_STREAM_TIMEOUT_SEC,
    PCM_WINDOW_TIMEOUT_SEC,
    AudioProbe,
    FFmpegEngine,
)
from podcast_mcp.engines.waveform_pyramid import (
    BIN_BYTES,
    HEADER_BYTES,
    HEADER_STRUCT,
    LEVEL_STRUCT,
    MAGIC,
    build_levels,
    build_pyramid,
    decode_media,
    media_key,
    prune_ref_pyramids,
    pyramid_build_failed,
    pyramid_build_pending,
    pyramid_path,
    read_bins,
    read_meta,
    read_pcm_minmax,
    ref_slug,
    reuse_existing_pyramid,
    schedule_pyramid_build,
    wait_pyramid_jobs,
    write_pyramid,
    write_synthetic_pyramid,
)
from podcast_mcp.util.process import run

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not available")

FULL = 32767


# --- Helpers ----------------------------------------------------------------------


def _key() -> str:
    return secrets.token_hex(10)


def _reference_levels(
    data: np.ndarray, *, base_spp: int, factor: int, bins_per_tile: int
) -> list[np.ndarray]:
    """Brute-force per-bin min/max/RMS straight from the samples (float64)."""
    total = len(data)
    if total == 0:
        return [np.zeros((0, 3), dtype=np.int16)]
    levels: list[np.ndarray] = []
    spp = base_spp
    while True:
        n = -(-total // spp)
        out = np.zeros((n, 3), dtype=np.int16)
        for i in range(n):
            seg = data[i * spp : min((i + 1) * spp, total)].astype(np.float64).ravel()
            out[i, 0] = np.clip(np.floor(seg.min() * FULL), -FULL, FULL)
            out[i, 1] = np.clip(np.ceil(seg.max() * FULL), -FULL, FULL)
            out[i, 2] = np.clip(np.round(np.sqrt(np.mean(seg**2)) * FULL), 0, FULL)
        levels.append(out)
        if n <= bins_per_tile:
            return levels
        spp *= factor


def _split(data: np.ndarray, rng: np.random.Generator) -> list[np.ndarray]:
    """Random chunk boundaries so the level-0 carry is exercised."""
    if len(data) < 2:
        return [data]
    cuts = np.sort(rng.integers(1, len(data), size=min(6, len(data) - 1)))
    return [c for c in np.split(data, cuts)]


def _write_int_wav(path: Path, ints: np.ndarray, *, width: int, sr: int = 8000) -> None:
    """Write integer PCM with the stdlib (8-bit stored unsigned, 24-bit packed)."""
    ch = ints.shape[1]
    flat = ints.reshape(-1).astype(np.int64)
    if width == 1:
        raw = (flat + 128).astype(np.uint8).tobytes()
    elif width == 3:
        u = flat & 0xFFFFFF
        raw = np.stack([u & 0xFF, (u >> 8) & 0xFF, (u >> 16) & 0xFF], axis=1).astype(np.uint8)
        raw = raw.tobytes()
    else:
        raw = flat.astype(f"<i{width}").tobytes()
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(ch)
        wf.setsampwidth(width)
        wf.setframerate(sr)
        wf.writeframes(raw)


_GUID_TAIL = bytes.fromhex("000000001000800000aa00389b71")


def _write_raw_wav(
    path: Path,
    data: bytes,
    *,
    channels: int,
    sr: int,
    bits: int,
    fmt_tag: int = 1,
    extensible_sub: int | None = None,
) -> None:
    """Hand-built RIFF/WAVE (float and WAVE_FORMAT_EXTENSIBLE headers)."""
    block = channels * bits // 8
    if extensible_sub is None:
        fmt = struct.pack("<HHIIHH", fmt_tag, channels, sr, sr * block, block, bits)
    else:
        fmt = struct.pack("<HHIIHH", 0xFFFE, channels, sr, sr * block, block, bits)
        guid = struct.pack("<H", extensible_sub) + _GUID_TAIL
        fmt += struct.pack("<HHI", 22, bits, (1 << channels) - 1) + guid
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt
    body += b"data" + struct.pack("<I", len(data)) + data
    path.write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)


def _float_wav(tmp_path: Path, frames: int = 3000, ch: int = 2, sr: int = 8000) -> np.ndarray:
    rng = np.random.default_rng(7)
    data = rng.uniform(-0.9, 0.9, size=(frames, ch)).astype(np.float32)
    _write_raw_wav(
        tmp_path / "float.wav", data.astype("<f4").tobytes(), channels=ch, sr=sr, bits=32, fmt_tag=3
    )
    return data


# --- Format constants -----------------------------------------------------------------


def test_header_and_level_structs_have_spec_sizes():
    assert HEADER_STRUCT.size == 64 == HEADER_BYTES
    assert LEVEL_STRUCT.size == 16
    assert BIN_BYTES == 6
    assert MAGIC == b"WFPK"


# --- build_levels ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("frames", "channels", "scale"),
    [
        (64 * 37 + 13, 3, 0.8),  # partial tail, multichannel
        (64 * 40, 2, 0.5),  # multiple-of-64 boundary
        (64 * 25 + 1, 1, 3.0),  # values above 1.0 clip
        (1, 2, 0.4),
        (17, 1, 0.9),
        (63, 2, 0.7),
    ],
)
def test_build_levels_matches_brute_force(frames, channels, scale):
    rng = np.random.default_rng(frames * 31 + channels)
    data = (rng.standard_normal((frames, channels)) * scale).astype(np.float32)
    total, levels = build_levels(
        _split(data, rng),
        sample_rate=8000,
        channels=channels,
        base_spp=64,
        factor=4,
        bins_per_tile=4,
    )
    ref = _reference_levels(data, base_spp=64, factor=4, bins_per_tile=4)
    assert total == frames
    assert len(levels) == len(ref)
    for got, want in zip(levels, ref, strict=True):
        assert got.dtype == np.int16
        np.testing.assert_array_equal(got[:, :2], want[:, :2])
        assert np.max(np.abs(got[:, 2].astype(int) - want[:, 2].astype(int))) <= 1


def test_build_levels_never_under_reports():
    rng = np.random.default_rng(3)
    data = (rng.standard_normal((64 * 90 + 5, 2)) * 0.3).astype(np.float32)
    _, levels = build_levels([data], sample_rate=8000, channels=2, base_spp=64, bins_per_tile=8)
    spp = 64
    for level in levels:
        for i, (lo, hi, _rms) in enumerate(level):
            seg = data[i * spp : (i + 1) * spp]
            assert lo / FULL <= max(-1.0, float(seg.min()))
            assert hi / FULL >= min(1.0, float(seg.max()))
        spp *= 4


def test_build_levels_silence_and_nan_are_zero():
    silent = np.zeros((64 * 5 + 3, 2), dtype=np.float32)
    nan = np.full((10, 2), np.nan, dtype=np.float32)
    _, levels = build_levels([silent, nan], sample_rate=8000, channels=2)
    assert not levels[0].any()


def test_build_levels_default_knobs_add_levels_past_one_tile():
    frames = 64 * 4096 + 1
    total, levels = build_levels(
        [np.zeros(frames, dtype=np.float32)], sample_rate=48000, channels=1
    )
    assert total == frames
    assert [len(lv) for lv in levels] == [4097, 1025]


def test_build_levels_empty_gives_one_empty_level():
    total, levels = build_levels([np.zeros((0, 2), dtype=np.float32)], sample_rate=8000, channels=2)
    assert total == 0
    assert len(levels) == 1
    assert levels[0].shape == (0, 3)


def test_build_levels_rejects_bad_input():
    with pytest.raises(ValueError):
        build_levels([], sample_rate=0, channels=1)
    with pytest.raises(ValueError):
        build_levels([np.zeros((4, 3), dtype=np.float32)], sample_rate=8000, channels=2)
    with pytest.raises(ValueError):
        build_levels([], sample_rate=8000, channels=1, factor=1)


# --- write / read --------------------------------------------------------------------------


def _small_pyramid(tmp_path: Path, name: str = "p.wfpk") -> tuple[Path, np.ndarray, list]:
    rng = np.random.default_rng(11)
    data = (rng.standard_normal((64 * 50 + 9, 2)) * 0.4).astype(np.float32)
    total, levels = build_levels([data], sample_rate=16000, channels=2, bins_per_tile=4)
    out = write_pyramid(
        tmp_path / name,
        sample_rate=16000,
        channels=2,
        total_frames=total,
        levels=levels,
        bins_per_tile=4,
    )
    return out, data, levels


def test_write_read_round_trip(tmp_path):
    out, data, levels = _small_pyramid(tmp_path)
    meta = read_meta(out)
    assert meta.version == 1
    assert meta.sample_rate == 16000
    assert meta.channels == 2
    assert meta.total_frames == len(data)
    assert meta.base_spp == 64
    assert meta.level_factor == 4
    assert meta.bins_per_tile == 4
    assert meta.header_bytes == 64 + 16 * len(levels)
    assert [lv.spp for lv in meta.levels] == [64 * 4**i for i in range(len(levels))]
    assert [lv.bins for lv in meta.levels] == [len(lv) for lv in levels]
    for idx, level in enumerate(levels):
        raw = read_bins(out, meta, idx, 0, len(level))
        got = np.frombuffer(raw, dtype="<i2").reshape(-1, 3)
        np.testing.assert_array_equal(got, level)
    tail = read_bins(out, meta, 0, len(levels[0]) - 2, 100)
    assert len(tail) == 2 * BIN_BYTES
    assert read_bins(out, meta, 0, len(levels[0]) + 5, 3) == b""
    with pytest.raises(ValueError):
        read_bins(out, meta, len(levels), 0, 1)
    with pytest.raises(ValueError):
        read_bins(out, meta, 0, -1, 1)


def test_write_is_byte_identical_across_runs(tmp_path):
    a, _, _ = _small_pyramid(tmp_path, "a.wfpk")
    b, _, _ = _small_pyramid(tmp_path, "b.wfpk")
    assert a.read_bytes() == b.read_bytes()


def test_empty_pyramid_round_trip(tmp_path):
    total, levels = build_levels([], sample_rate=8000, channels=1)
    out = write_pyramid(
        tmp_path / "e.wfpk", sample_rate=8000, channels=1, total_frames=total, levels=levels
    )
    meta = read_meta(out)
    assert meta.total_frames == 0
    assert [(lv.spp, lv.bins) for lv in meta.levels] == [(64, 0)]
    assert read_bins(out, meta, 0, 0, 16) == b""


def test_write_pyramid_rejects_bad_levels(tmp_path):
    out = tmp_path / "x.wfpk"
    with pytest.raises(ValueError):
        write_pyramid(out, sample_rate=8000, channels=1, total_frames=0, levels=[])
    with pytest.raises(ValueError):
        write_pyramid(
            out,
            sample_rate=8000,
            channels=1,
            total_frames=64,
            levels=[np.zeros((1, 2), dtype=np.int16)],
        )
    with pytest.raises(ValueError):
        write_pyramid(
            out,
            sample_rate=8000,
            channels=1,
            total_frames=640,
            levels=[np.zeros((3, 3), dtype=np.int16)],
        )
    assert not out.exists()


def _patch_header(blob: bytearray, field: int, value) -> None:
    fields = list(HEADER_STRUCT.unpack_from(blob, 0))
    fields[field] = value
    blob[:64] = HEADER_STRUCT.pack(*fields)


def _patch_level(blob: bytearray, idx: int, field: int, value) -> None:
    fields = list(LEVEL_STRUCT.unpack_from(blob, 64 + 16 * idx))
    fields[field] = value
    blob[64 + 16 * idx : 80 + 16 * idx] = LEVEL_STRUCT.pack(*fields)


@pytest.mark.parametrize(
    "corrupt",
    [
        pytest.param(lambda b: b.__setitem__(slice(0, 4), b"NOPE"), id="magic"),
        pytest.param(lambda b: _patch_header(b, 1, 2), id="version"),
        pytest.param(lambda b: _patch_header(b, 2, 70), id="header-bytes"),
        pytest.param(lambda b: _patch_header(b, 8, 0), id="level-count"),
        pytest.param(lambda b: _patch_header(b, 10, 8), id="bin-bytes"),
        pytest.param(lambda b: _patch_header(b, 3, 0), id="sample-rate"),
        pytest.param(lambda b: _patch_header(b, 6, 128), id="base-spp"),
        pytest.param(lambda b: _patch_level(b, 1, 0, 64), id="spp-not-monotonic"),
        pytest.param(lambda b: _patch_level(b, 0, 1, 7), id="bins-mismatch"),
        pytest.param(lambda b: _patch_level(b, 0, 2, 10), id="offset-in-header"),
        pytest.param(lambda b: b.__delitem__(slice(len(b) - 6, len(b))), id="truncated-data"),
        pytest.param(lambda b: b.__delitem__(slice(70, len(b))), id="truncated-table"),
        pytest.param(lambda b: b.__delitem__(slice(40, len(b))), id="truncated-header"),
    ],
)
def test_read_meta_rejects_corrupt_files(tmp_path, corrupt):
    out, _, _ = _small_pyramid(tmp_path)
    blob = bytearray(out.read_bytes())
    corrupt(blob)
    out.write_bytes(bytes(blob))
    with pytest.raises(ValueError):
        read_meta(out)


def test_publish_uses_unique_temp_names_and_cleans_up(tmp_path):
    out = tmp_path / "peaks" / "track-a.0123456789abcdef0123.wfpk"
    names: list[str] = []

    def _write(fh):
        names.append(Path(fh.name).name)
        fh.write(b"x")

    wp._publish(out, _write)
    wp._publish(out, _write)  # target exists: replaced atomically
    assert len(set(names)) == 2
    for name in names:
        assert name.startswith(f".{out.name}.")
        assert name.endswith(".tmp")
    assert out.read_bytes() == b"x"
    assert sorted(p.name for p in out.parent.iterdir()) == [out.name]


def test_publish_removes_temp_on_failure(tmp_path):
    out = tmp_path / "x.wfpk"

    def _boom(fh):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        wp._publish(out, _boom)
    with (
        patch("podcast_mcp.engines.waveform_pyramid.os.replace", side_effect=OSError("ro")),
        pytest.raises(OSError),
    ):
        wp._publish(out, lambda fh: fh.write(b"y"))
    assert list(tmp_path.iterdir()) == []


def test_publish_fsyncs_file_and_directory(tmp_path):
    out = tmp_path / "peaks" / "f.wfpk"
    with patch("podcast_mcp.engines.waveform_pyramid.os.fsync", wraps=os.fsync) as fsync:
        wp._publish(out, lambda fh: fh.write(b"z"))
    assert fsync.call_count == 2  # temp file, then the directory
    assert out.read_bytes() == b"z"
    with patch("podcast_mcp.engines.waveform_pyramid.os.open", side_effect=OSError("dir")):
        wp._fsync_dir(out.parent)  # best effort: no raise


def test_publish_replaces_a_corrupt_existing_file(tmp_path):
    out = tmp_path / "p.wfpk"
    out.write_bytes(b"torn")
    wp._publish(out, lambda fh: fh.write(b"fresh"))
    assert out.read_bytes() == b"fresh"


# --- Decode --------------------------------------------------------------------------------


@pytest.mark.parametrize("width", [1, 2, 3, 4])
def test_decode_media_int_wav_widths(tmp_path, width):
    bits = 8 * width
    lo, hi = -(1 << (bits - 1)), (1 << (bits - 1)) - 1
    ints = np.array([[lo, hi], [0, -1], [1, lo + 1], [hi, 0]] * 40, dtype=np.int64)
    path = tmp_path / f"w{width}.wav"
    _write_int_wav(path, ints, width=width, sr=11025)
    sr, ch, chunks = decode_media(path)
    assert (sr, ch) == (11025, 2)
    data = np.concatenate(list(chunks))
    expected = ints.astype(np.float64) / float(1 << (bits - 1))
    np.testing.assert_allclose(data, expected, atol=1e-7)
    assert data.dtype == np.float32
    assert data.min() == -1.0


def test_iter_wav_exact_chunk_multiple(tmp_path):
    path = tmp_path / "w.wav"
    _write_int_wav(path, np.arange(256, dtype=np.int64).reshape(128, 2), width=2)
    info = wp._wav_info(path)
    assert info is not None
    chunks = list(wp._iter_wav(path, info, 64))
    assert [len(c) for c in chunks] == [64, 64]


def test_wav_info_rejects_unsupported_widths(tmp_path):
    path = tmp_path / "s64.wav"
    _write_raw_wav(path, b"\0" * 64, channels=1, sr=8000, bits=64)
    assert wp._wav_info(path) is None
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"not a riff file")
    assert wp._wav_info(junk) is None


@pytest.mark.parametrize("declared", [0, 0xFFFFFFFF, 4 * 200 + 8])
def test_wav_info_rejects_a_data_size_the_file_does_not_hold(tmp_path, declared):
    path = tmp_path / "bad.wav"
    _write_int_wav(path, np.ones((200, 2), dtype=np.int64), width=2)
    good = wp._wav_info(path)
    assert good is not None and good.frames == 200
    blob = bytearray(path.read_bytes())
    assert blob[36:40] == b"data"
    blob[40:44] = struct.pack("<I", declared)
    path.write_bytes(bytes(blob))
    assert wp._wav_info(path) is None
    eng = MagicMock()
    decode_media(path, engine=eng)
    eng.stream_pcm_f32.assert_called_once()


def test_wav_info_keeps_an_empty_wav_on_the_fast_path(tmp_path):
    path = tmp_path / "empty.wav"
    _write_int_wav(path, np.zeros((0, 1), dtype=np.int64), width=2)
    info = wp._wav_info(path)
    assert info is not None and info.frames == 0


@needs_ffmpeg
def test_decode_media_extensible_wav_falls_back_to_ffmpeg(tmp_path):
    # Python 3.12+ ``wave`` reads extensible *PCM*, so use the float subformat,
    # which every supported version rejects.
    rng = np.random.default_rng(5)
    samples = rng.uniform(-0.9, 0.9, size=(2500, 2)).astype(np.float32)
    path = tmp_path / "ext.wav"
    _write_raw_wav(
        path, samples.astype("<f4").tobytes(), channels=2, sr=8000, bits=32, extensible_sub=3
    )
    assert wp._wav_info(path) is None
    eng = FFmpegEngine()
    with patch.object(eng, "stream_pcm_f32", wraps=eng.stream_pcm_f32) as spy:
        sr, ch, chunks = decode_media(path, engine=eng)
        data = np.concatenate(list(chunks))
    spy.assert_called_once()
    assert (sr, ch) == (8000, 2)
    np.testing.assert_array_equal(data, samples)


@needs_ffmpeg
def test_decode_media_float_wav_and_stream_chunks(tmp_path):
    data = _float_wav(tmp_path)
    sr, ch, chunks = FFmpegEngine().stream_pcm_f32(tmp_path / "float.wav", chunk_frames=1000)
    parts = list(chunks)
    assert (sr, ch) == (8000, 2)
    assert [len(p) for p in parts] == [1000, 1000, 1000]
    np.testing.assert_array_equal(np.concatenate(parts), data)
    sr, ch, chunks = decode_media(tmp_path / "float.wav")
    np.testing.assert_array_equal(np.concatenate(list(chunks)), data)
    with pytest.raises(ValueError):
        FFmpegEngine().stream_pcm_f32(tmp_path / "float.wav", chunk_frames=0)


@needs_ffmpeg
def test_decode_and_build_mp3(tmp_path):
    eng = FFmpegEngine()
    mp3 = tmp_path / "tone.mp3"
    run(
        [
            eng.ffmpeg,
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-ac",
            "2",
            "-ar",
            "44100",
            str(mp3),
        ],
        check=True,
        timeout=60,
    )
    sr, ch, chunks = decode_media(mp3, engine=eng)
    total, levels = build_levels(chunks, sample_rate=sr, channels=ch)
    assert (sr, ch) == (44100, 2)
    assert 44100 <= total <= 44100 + 4096
    assert levels[0][:, 1].max() > 0.05 * FULL
    assert levels[0][:, 0].min() < -0.05 * FULL


# --- read_pcm_minmax -----------------------------------------------------------------------


def test_read_pcm_minmax_wav_edges(tmp_path):
    rng = np.random.default_rng(9)
    ints = rng.integers(-30000, 30000, size=(500, 2), dtype=np.int64)
    path = tmp_path / "m.wav"
    _write_int_wav(path, ints, width=2)
    f = ints.astype(np.float64) / 32768.0
    want_lo = np.floor(f.min(axis=1) * FULL)
    want_hi = np.ceil(f.max(axis=1) * FULL)

    head = read_pcm_minmax(path, 0, 10)
    assert head.dtype == np.int16
    np.testing.assert_array_equal(head[:, 0], want_lo[:10])
    np.testing.assert_array_equal(head[:, 1], want_hi[:10])
    tail = read_pcm_minmax(path, 495, 100)
    assert tail.shape == (5, 2)
    np.testing.assert_array_equal(tail[:, 1], want_hi[495:])
    assert read_pcm_minmax(path, 900, 10).shape == (0, 2)
    with pytest.raises(ValueError):
        read_pcm_minmax(path, -1, 10)
    cap = wp.PCM_WINDOW_MAX_BLOCKS * 65536
    assert read_pcm_minmax(path, 0, cap).shape == (500, 2)
    with pytest.raises(ValueError, match="exceeds"):
        read_pcm_minmax(path, 0, cap + 1)


@needs_ffmpeg
def test_read_pcm_minmax_ffmpeg_window(tmp_path):
    data = _float_wav(tmp_path)
    path = tmp_path / "float.wav"
    f = data.astype(np.float64)
    lo = np.floor(f.min(axis=1) * FULL)
    hi = np.ceil(f.max(axis=1) * FULL)

    mid = read_pcm_minmax(path, 1000, 500, sample_rate=8000, channels=2)
    np.testing.assert_array_equal(mid[:, 0], lo[1000:1500])
    np.testing.assert_array_equal(mid[:, 1], hi[1000:1500])
    head = read_pcm_minmax(path, 0, 7)  # probes sample rate / channels
    np.testing.assert_array_equal(head[:, 1], hi[:7])
    tail = read_pcm_minmax(path, 2990, 100, sample_rate=8000, channels=2)
    assert tail.shape == (10, 2)
    np.testing.assert_array_equal(tail[:, 0], lo[2990:])


def test_decode_window_f32_validates_and_short_circuits(tmp_path):
    eng = FFmpegEngine(ffmpeg="ffmpeg", ffprobe="ffprobe")
    assert eng.decode_window_f32(tmp_path / "x.wav", 0, 0, 8000, 2).shape == (0, 2)
    with pytest.raises(ValueError):
        eng.decode_window_f32(tmp_path / "x.wav", -1, 10, 8000, 2)


# --- ffmpeg process lifecycle (mocked) ------------------------------------------------------


class _FakeProc:
    """popen stand-in whose stdout blocks until killed (or serves canned bytes)."""

    def __init__(self, payload: bytes | None = None, code: int = 0) -> None:
        self.killed = threading.Event()
        self._payload = payload
        self._code = code
        self.stdout = MagicMock()
        self.stdout.read.side_effect = self._read
        self.kill = MagicMock(side_effect=self.killed.set)

    def _read(self, n: int) -> bytes:
        if self._payload is None:
            self.killed.wait(timeout=5)
            return b""
        out, self._payload = self._payload[:n], self._payload[n:]
        return out

    def poll(self):
        return -9 if self.killed.is_set() else (self._code if self._payload == b"" else None)

    def wait(self):
        return -9 if self.killed.is_set() else self._code


class _ImmediateTimer:
    instances: ClassVar[list[_ImmediateTimer]] = []

    def __init__(self, interval, fn):
        self.interval = interval
        self.fn = fn
        self.cancelled = False
        self.daemon = False
        _ImmediateTimer.instances.append(self)

    def start(self):
        self.fn()

    def cancel(self):
        self.cancelled = True


def _probe(*_a, **_k):
    return AudioProbe(duration_sec=1.0, sample_rate=8000, channels=1)


def test_stream_timer_kills_stuck_process(tmp_path):
    proc = _FakeProc()
    _ImmediateTimer.instances.clear()
    eng = FFmpegEngine(ffmpeg="ffmpeg", ffprobe="ffprobe")
    with (
        patch.object(FFmpegEngine, "probe", side_effect=_probe),
        patch("podcast_mcp.engines.ffmpeg.popen", return_value=proc) as popen,
        patch("podcast_mcp.engines.ffmpeg.threading.Timer", _ImmediateTimer),
    ):
        _, _, chunks = eng.stream_pcm_f32(tmp_path / "stuck.wav")
        with pytest.raises(RuntimeError, match=r"exit -9\); killed by the 600 s watchdog"):
            list(chunks)
    proc.kill.assert_called()
    timer = _ImmediateTimer.instances[0]
    assert timer.interval == PCM_STREAM_TIMEOUT_SEC == 600.0
    assert timer.cancelled
    argv = popen.call_args[0][0]
    assert argv[:9] == [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,crypto,data",
        "-threads",
        "1",
    ]
    assert argv[-7:] == ["-f", "f32le", "-ac", "1", "-ar", "8000", "pipe:1"]


def test_window_uses_seek_before_input_and_short_timer(tmp_path):
    payload = np.arange(20, dtype="<f4").tobytes()
    proc = _FakeProc(payload)
    _ImmediateTimer.instances.clear()

    class _LazyTimer(_ImmediateTimer):
        def start(self):
            pass

    eng = FFmpegEngine(ffmpeg="ffmpeg", ffprobe="ffprobe")
    with (
        patch("podcast_mcp.engines.ffmpeg.popen", return_value=proc) as popen,
        patch("podcast_mcp.engines.ffmpeg.threading.Timer", _LazyTimer),
    ):
        out = eng.decode_window_f32(tmp_path / "a.wav", 800, 4, 8000, 2)
    assert out.shape == (4, 2)
    np.testing.assert_array_equal(out.ravel(), np.arange(8, dtype=np.float32))
    argv = popen.call_args[0][0]
    assert argv.index("-ss") < argv.index("-i")
    assert argv[argv.index("-ss") + 1] == "0.100000000"
    assert "-t" in argv
    assert _ImmediateTimer.instances[0].interval == PCM_WINDOW_TIMEOUT_SEC == 30.0
    proc.kill.assert_called_once()  # stopped once the window was full


def test_stream_close_kills_running_process(tmp_path):
    proc = _FakeProc(b"\0" * 4 * 10_000)

    class _LazyTimer(_ImmediateTimer):
        def start(self):
            pass

    eng = FFmpegEngine(ffmpeg="ffmpeg", ffprobe="ffprobe")
    with (
        patch.object(FFmpegEngine, "probe", side_effect=_probe),
        patch("podcast_mcp.engines.ffmpeg.popen", return_value=proc),
        patch("podcast_mcp.engines.ffmpeg.threading.Timer", _LazyTimer),
    ):
        _, _, chunks = eng.stream_pcm_f32(tmp_path / "a.wav", chunk_frames=100)
        assert len(next(chunks)) == 100
        chunks.close()
    proc.kill.assert_called_once()


def test_stream_watchdog_is_disarmed_while_the_consumer_holds_a_chunk(tmp_path):
    proc = _FakeProc(np.ones(250, dtype="<f4").tobytes())
    _ImmediateTimer.instances.clear()

    class _LazyTimer(_ImmediateTimer):
        def start(self):
            pass

    eng = FFmpegEngine(ffmpeg="ffmpeg", ffprobe="ffprobe")
    with (
        patch.object(FFmpegEngine, "probe", side_effect=_probe),
        patch("podcast_mcp.engines.ffmpeg.popen", return_value=proc),
        patch("podcast_mcp.engines.ffmpeg.threading.Timer", _LazyTimer),
    ):
        _, _, chunks = eng.stream_pcm_f32(tmp_path / "a.wav", chunk_frames=100)
        assert len(next(chunks)) == 100
        # One watchdog per chunk, already cancelled while the consumer works.
        assert len(_ImmediateTimer.instances) == 1
        assert _ImmediateTimer.instances[0].cancelled
        assert [len(c) for c in chunks] == [100, 50]
    assert len(_ImmediateTimer.instances) == 3
    assert all(t.cancelled for t in _ImmediateTimer.instances)
    assert all(t.interval == PCM_STREAM_TIMEOUT_SEC for t in _ImmediateTimer.instances)


def test_stream_failure_reports_the_stderr_tail(tmp_path):
    def _popen(argv, *, stdout, stderr):
        stderr.write(b"x" * 5000 + b"\nmoov atom not found\n")
        return _FakeProc(b"", code=1)

    class _LazyTimer(_ImmediateTimer):
        def start(self):
            pass

    eng = FFmpegEngine(ffmpeg="ffmpeg", ffprobe="ffprobe")
    with (
        patch.object(FFmpegEngine, "probe", side_effect=_probe),
        patch("podcast_mcp.engines.ffmpeg.popen", side_effect=_popen),
        patch("podcast_mcp.engines.ffmpeg.threading.Timer", _LazyTimer),
    ):
        _, _, chunks = eng.stream_pcm_f32(tmp_path / "a.wav")
        with pytest.raises(RuntimeError, match=r"exit 1\)") as exc:
            list(chunks)
    msg = str(exc.value)
    assert msg.endswith("moov atom not found")
    assert "watchdog" not in msg
    assert len(msg) < 2200  # only the last PCM_STDERR_TAIL_BYTES


def test_stream_clean_eof_and_missing_pipe(tmp_path):
    proc = _FakeProc(np.ones(150, dtype="<f4").tobytes())
    empty = _FakeProc(b"")

    class _LazyTimer(_ImmediateTimer):
        def start(self):
            pass

    eng = FFmpegEngine(ffmpeg="ffmpeg", ffprobe="ffprobe")
    with (
        patch.object(FFmpegEngine, "probe", side_effect=_probe),
        patch("podcast_mcp.engines.ffmpeg.threading.Timer", _LazyTimer),
    ):
        with patch("podcast_mcp.engines.ffmpeg.popen", return_value=proc):
            _, _, chunks = eng.stream_pcm_f32(tmp_path / "a.wav", chunk_frames=100)
            assert [len(c) for c in chunks] == [100, 50]
        proc.kill.assert_not_called()
        with patch("podcast_mcp.engines.ffmpeg.popen", return_value=empty):
            assert eng.decode_window_f32(tmp_path / "a.wav", 0, 10, 8000, 1).shape == (0, 1)
        empty.stdout = None
        with patch("podcast_mcp.engines.ffmpeg.popen", return_value=empty):
            _, _, chunks = eng.stream_pcm_f32(tmp_path / "a.wav")
            with pytest.raises(RuntimeError, match="stdout"):
                list(chunks)


# --- Keys, paths, prune, reuse -----------------------------------------------------------


def test_media_key_is_20_hex_and_tracks_path_size_mtime():
    key = media_key("raw/host.wav", 100, 5)
    assert len(key) == 20
    assert int(key, 16) >= 0
    assert key == media_key("raw/host.wav", 100, 5)
    assert key != media_key("raw/host.wav", 101, 5)
    assert key != media_key("raw/host.wav", 100, 6)
    assert key != media_key("raw/guest.wav", 100, 5)


def test_ref_slug_and_pyramid_path(tmp_path):
    assert ref_slug("track", "host_1") == "track-host_1"
    hashed = ref_slug("source", "../weird id")
    assert hashed.startswith("source-h")
    assert len(hashed) == len("source-h") + 12
    key = _key()
    path = pyramid_path(tmp_path, hashed, key)
    assert path == (tmp_path / f"{hashed}.{key}.wfpk").resolve()
    with pytest.raises(ValueError):
        pyramid_path(tmp_path, "../evil", key)
    with pytest.raises(ValueError):
        pyramid_path(tmp_path, "track-a", "NOTAKEY")


def test_prune_keeps_live_and_previous_and_old_tmp(tmp_path):
    live, prev, old = _key(), _key(), _key()
    now = time.time()
    files = {}
    for key, age in ((live, 300), (prev, 100), (old, 200)):
        p = tmp_path / f"track-a.{key}.wfpk"
        p.write_bytes(b"x")
        os.utime(p, (now - age, now - age))
        files[key] = p
    other = tmp_path / f"track-b.{old}.wfpk"
    other.write_bytes(b"x")
    odd = tmp_path / "track-a.notakey.wfpk"
    odd.write_bytes(b"x")
    stale_tmp = tmp_path / ".track-a.x.wfpk.abc.tmp"
    stale_tmp.write_bytes(b"")
    os.utime(stale_tmp, (now - 2 * 86400, now - 2 * 86400))
    fresh_tmp = tmp_path / ".track-a.y.wfpk.def.tmp"
    fresh_tmp.write_bytes(b"")

    prune_ref_pyramids(tmp_path, "track-a", live)

    assert files[live].exists()
    assert files[prev].exists()
    assert not files[old].exists()
    assert other.exists()
    assert odd.exists()
    assert not stale_tmp.exists()
    assert fresh_tmp.exists()


def test_reuse_existing_pyramid_links_or_copies(tmp_path):
    out_src, _, _ = _small_pyramid(tmp_path)
    key = _key()
    src = tmp_path / f"track-a.{key}.wfpk"
    out_src.rename(src)
    out = tmp_path / f"source-s1.{key}.wfpk"
    assert reuse_existing_pyramid(tmp_path, _key(), tmp_path / "none.wfpk") is False
    assert reuse_existing_pyramid(tmp_path, key, out) is True
    assert out.stat().st_ino == src.stat().st_ino
    assert reuse_existing_pyramid(tmp_path, key, out) is True  # already there

    copied = tmp_path / f"stem-t1.{key}.wfpk"
    with patch("podcast_mcp.engines.waveform_pyramid.os.link", side_effect=OSError("xdev")):
        assert reuse_existing_pyramid(tmp_path, key, copied) is True
    assert copied.read_bytes() == src.read_bytes()
    assert copied.stat().st_ino != src.stat().st_ino


def test_reuse_repairs_a_corrupt_target_and_skips_corrupt_candidates(tmp_path):
    src, _, _ = _small_pyramid(tmp_path)
    key = _key()
    good = tmp_path / f"track-a.{key}.wfpk"
    src.rename(good)
    out = tmp_path / f"source-s1.{key}.wfpk"
    out.write_bytes(b"torn")
    assert reuse_existing_pyramid(tmp_path, key, out) is True
    assert out.read_bytes() == good.read_bytes()
    read_meta(out)

    bad_key = _key()
    (tmp_path / f"track-b.{bad_key}.wfpk").write_bytes(b"junk")
    target = tmp_path / f"source-s2.{bad_key}.wfpk"
    assert reuse_existing_pyramid(tmp_path, bad_key, target) is False
    assert not target.exists()

    stuck = tmp_path / f"source-s3.{bad_key}.wfpk"
    stuck.write_bytes(b"torn")
    with patch.object(Path, "unlink", side_effect=OSError("busy")):
        assert reuse_existing_pyramid(tmp_path, bad_key, stuck) is False

    raced = tmp_path / f"track-z.{key}.wfpk"
    with patch("podcast_mcp.engines.waveform_pyramid.os.link", side_effect=FileExistsError()):
        assert reuse_existing_pyramid(tmp_path, key, raced) is True

    failed = tmp_path / f"track-y.{key}.wfpk"
    with (
        patch("podcast_mcp.engines.waveform_pyramid.os.link", side_effect=OSError("xdev")),
        patch("podcast_mcp.engines.waveform_pyramid._copy_into", side_effect=OSError("io")),
    ):
        assert reuse_existing_pyramid(tmp_path, key, failed) is False
    assert not failed.exists()


# --- Synthetic pyramids ------------------------------------------------------------------------


def test_write_synthetic_pyramid_is_deterministic_and_speech_like(tmp_path):
    a = write_synthetic_pyramid(
        tmp_path / "a.wfpk", sample_rate=48000, total_frames=48000 * 60, seed=4
    )
    b = write_synthetic_pyramid(
        tmp_path / "b.wfpk", sample_rate=48000, total_frames=48000 * 60, seed=4
    )
    c = write_synthetic_pyramid(
        tmp_path / "c.wfpk", sample_rate=48000, total_frames=48000 * 60, seed=5
    )
    assert a.read_bytes() == b.read_bytes()
    assert a.read_bytes() != c.read_bytes()
    meta = read_meta(a)
    assert meta.channels == 1
    assert [lv.bins for lv in meta.levels] == [45000, 11250, 2813]
    bins = np.frombuffer(read_bins(a, meta, 0, 0, 45000), dtype="<i2").reshape(-1, 3)
    peak = bins[:, 1].astype(int)
    assert peak.max() > 0.1 * FULL
    assert (peak < 0.01 * FULL).mean() > 0.05  # pauses between phrases
    assert (bins[:, 0] <= 0).all()
    assert (bins[:, 2] <= bins[:, 1]).all()


def test_write_synthetic_pyramid_silent_and_empty(tmp_path):
    silent = write_synthetic_pyramid(
        tmp_path / "s.wfpk", sample_rate=8000, total_frames=8000, seed=1, silent=True
    )
    meta = read_meta(silent)
    assert not any(read_bins(silent, meta, 0, 0, meta.levels[0].bins))
    empty = write_synthetic_pyramid(tmp_path / "e.wfpk", sample_rate=8000, total_frames=0, seed=1)
    assert read_meta(empty).levels[0].bins == 0
    with pytest.raises(ValueError):
        write_synthetic_pyramid(tmp_path / "x.wfpk", sample_rate=0, total_frames=1, seed=1)


# --- build_pyramid and the job pool -------------------------------------------------------


def _wav_media(tmp_path: Path) -> Path:
    rng = np.random.default_rng(2)
    path = tmp_path / "raw" / "host.wav"
    path.parent.mkdir()
    _write_int_wav(path, rng.integers(-9000, 9000, size=(64 * 300, 1)), width=2, sr=8000)
    return path


def test_build_pyramid_writes_prunes_and_reuses(tmp_path):
    audio = _wav_media(tmp_path)
    peaks = tmp_path / "artifacts" / "peaks"
    peaks.mkdir(parents=True)
    old_key, key = _key(), _key()
    (peaks / f"track-host.{old_key}.wfpk").write_bytes(b"old")
    out = pyramid_path(peaks, "track-host", key)
    assert build_pyramid("track:host", key, audio, out) == out
    meta = read_meta(out)
    assert meta.total_frames == 64 * 300
    assert (peaks / f"track-host.{old_key}.wfpk").exists()  # previous key kept

    other = pyramid_path(peaks, "source-s1", key)
    with patch("podcast_mcp.engines.waveform_pyramid.decode_media") as decode:
        build_pyramid("source:s1", key, audio, other)
    decode.assert_not_called()
    assert other.read_bytes() == out.read_bytes()
    with pytest.raises(ValueError):
        build_pyramid("track:host", key, audio, peaks / "wrong-name.wfpk")


def test_schedule_dedupes_pending_jobs(tmp_path):
    audio = _wav_media(tmp_path)
    peaks = tmp_path / "peaks"
    key = _key()
    out = pyramid_path(peaks, "track-host", key)
    release = threading.Event()
    calls: list[int] = []
    real_decode = wp.decode_media

    def _blocked(path, **kw):
        calls.append(1)
        release.wait(timeout=5)
        return real_decode(path, **kw)

    with patch("podcast_mcp.engines.waveform_pyramid.decode_media", side_effect=_blocked):
        assert pyramid_build_pending("track-host", key) is False
        assert schedule_pyramid_build("track:host", key, audio, out) is True
        assert schedule_pyramid_build("track:host", key, audio, out) is True
        assert pyramid_build_pending("track-host", key) is True
        assert not out.exists()
        release.set()
        wait_pyramid_jobs()
    assert len(calls) == 1
    assert pyramid_build_pending("track-host", key) is False
    assert out.exists()  # not pending implies the file is in place (#421)
    assert pyramid_build_failed(key) is False


def test_schedule_remembers_failed_keys(tmp_path):
    audio = _wav_media(tmp_path)
    peaks = tmp_path / "peaks"
    key = _key()
    out = pyramid_path(peaks, "track-host", key)
    with patch("podcast_mcp.engines.waveform_pyramid.decode_media", side_effect=RuntimeError("x")):
        assert schedule_pyramid_build("track:host", key, audio, out) is True
        wait_pyramid_jobs()
    assert pyramid_build_failed(key) is True
    assert pyramid_build_pending("track-host", key) is False
    with patch("podcast_mcp.engines.waveform_pyramid.decode_media") as decode:
        assert schedule_pyramid_build("track:host", key, audio, out) is False
    decode.assert_not_called()
    fresh = _key()  # changed media -> new key -> retried
    assert schedule_pyramid_build(
        "track:host", fresh, audio, pyramid_path(peaks, "track-host", fresh)
    )
    wait_pyramid_jobs()
    assert pyramid_build_failed(fresh) is False


def test_failed_key_memory_is_bounded(monkeypatch):
    monkeypatch.setattr(wp, "_FAILED_MAX", 3)
    keys = [_key() for _ in range(5)]
    for key in keys:
        wp._remember_failed(key)
    assert [pyramid_build_failed(k) for k in keys] == [False, False, True, True, True]
    for key in keys:
        wp._FAILED.pop(key, None)


def test_failed_key_is_logged_and_retried_after_the_window(tmp_path, caplog):
    audio = _wav_media(tmp_path)
    key = _key()
    out = pyramid_path(tmp_path / "peaks", "track-host", key)
    with (
        caplog.at_level(logging.WARNING, logger="podcast_mcp.engines.waveform_pyramid"),
        patch("podcast_mcp.engines.waveform_pyramid.decode_media", side_effect=OSError("ENOSPC")),
    ):
        assert schedule_pyramid_build("track:host", key, audio, out) is True
        wait_pyramid_jobs()
    assert "waveform pyramid build failed for track:host" in caplog.text
    assert "ENOSPC" in caplog.text
    assert pyramid_build_failed(key) is True
    assert wp._FAILED[key] > 0
    wp._FAILED[key] = 0.0  # retry window elapsed
    assert pyramid_build_failed(key) is False
    assert key not in wp._FAILED
    assert schedule_pyramid_build("track:host", key, audio, out) is True
    wait_pyramid_jobs()
    assert out.exists()
    assert pyramid_build_failed(key) is False


def test_schedule_submit_failure_clears_pending(tmp_path):
    key = _key()
    out = pyramid_path(tmp_path, "track-host", key)
    pool = MagicMock()
    pool.submit.side_effect = RuntimeError("shutdown")
    with (
        patch("podcast_mcp.engines.waveform_pyramid._pyramid_pool", return_value=pool),
        pytest.raises(RuntimeError),
    ):
        schedule_pyramid_build("track:host", key, tmp_path / "a.wav", out)
    assert pyramid_build_pending("track-host", key) is False


def test_shutdown_pool_then_reschedule(tmp_path):
    audio = _wav_media(tmp_path)
    wp._shutdown_pyramid_pool()
    wp._shutdown_pyramid_pool()  # idle: nothing to shut down
    assert wp._POOL is None
    key = _key()
    out = pyramid_path(tmp_path / "peaks", "track-host", key)
    assert schedule_pyramid_build("track:host", key, audio, out) is True
    wp._shutdown_pyramid_pool()
    assert out.exists()
    assert wp._POOL is None
