from __future__ import annotations

import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
import pytest

import multistream_media as media
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.edits.loudness import check_loudness
from podcast_mcp.engines import align, decoded_source, ungated_audio
from podcast_mcp.engines import ffmpeg as ffmpeg_module
from podcast_mcp.engines.audio import MuteEnvelope
from podcast_mcp.engines.ffmpeg import _EBUR128_BLOCK_RE, FFmpegEngine
from podcast_mcp.engines.media_probe import probe_media
from podcast_mcp.engines.media_seek import MediaSeek
from podcast_mcp.engines.mono_downmix import ffmpeg_mono_mean_layout
from podcast_mcp.ingest.consolidate import consolidate_speakers
from podcast_mcp.ingest.manifest import IngestManifest
from podcast_mcp.util.pcm_stream import NoAudioDecodedError

RATE = 8000
EBUR128 = ("-af", "ebur128=framelog=info", "-f", "null", "-")
STREAMS = ["st.mkv", "kid.ogg", "two_b.mkv"]


def _ffmpeg_bytes(path: Path, *args: str) -> bytes:
    return subprocess.run(
        [FFmpegEngine().ffmpeg, "-v", "error", "-i", str(path), *args, "pipe:1"],
        check=True,
        capture_output=True,
    ).stdout


def _default_pick(path: Path, channels: int | None = None) -> np.ndarray:
    layout = ["-ac", "1"] if channels is None else ["-ac", str(channels)]
    raw = _ffmpeg_bytes(path, *layout, "-ar", str(RATE), "-f", "f32le")
    return np.frombuffer(raw, dtype=np.float32)


def _loudness_blocks(path: Path) -> list[tuple[float, float]]:
    result = subprocess.run(
        [*(FFmpegEngine().ffmpeg, "-hide_banner", "-nostats", "-i", str(path)), *EBUR128],
        capture_output=True,
        text=True,
    )
    return [(float(t), float(m)) for t, m in _EBUR128_BLOCK_RE.findall(result.stderr)]


@pytest.fixture(params=STREAMS)
def pair(request: pytest.FixtureRequest, tmp_path: Path) -> tuple[Path, Path]:
    source = media.multistream(tmp_path, request.param)
    oracle_dir = tmp_path / "oracle"
    oracle_dir.mkdir()
    return source, media.first_stream_only(source, oracle_dir)


@pytest.fixture(params=["wav", "m4a", "mp4", "mp3"])
def single(request: pytest.FixtureRequest, tmp_path: Path) -> Path:
    return media.single_stream_media(tmp_path)[request.param]


def test_load_mono_full_reads_first_stream(pair: tuple[Path, Path]) -> None:
    source, oracle = pair
    got = ungated_audio.load_mono_full(source, sample_rate=RATE)
    assert np.array_equal(got, ungated_audio.load_mono_full(oracle, sample_rate=RATE))
    assert not np.array_equal(got, _default_pick(source))


def test_load_channels_full_reads_first_stream(pair: tuple[Path, Path]) -> None:
    source, oracle = pair
    got = ungated_audio.load_channels_full(source, sample_rate=RATE)
    assert got.shape[1] == probe_media(source).channels
    assert np.array_equal(got, ungated_audio.load_channels_full(oracle, sample_rate=RATE))


def test_decoded_source_reads_first_stream(pair: tuple[Path, Path]) -> None:
    source, oracle = pair
    with decoded_source.decoded_sources(RATE) as held:
        spool, expected = held(source), held(oracle)
        assert spool.size == expected.size
        assert np.array_equal(spool.read(0, spool.size), expected.read(0, expected.size))


def test_load_mono_window_reads_first_stream(pair: tuple[Path, Path]) -> None:
    source, oracle = pair
    window = {"start_sec": 0.25, "duration_sec": 0.5, "sample_rate": RATE}
    got = align.load_mono_window(source, **window)
    assert got.size
    assert np.array_equal(got, align.load_mono_window(oracle, **window))


def test_engine_streams_read_first_stream(pair: tuple[Path, Path]) -> None:
    source, oracle = pair
    engine = FFmpegEngine()
    rate, channels, chunks = engine.stream_pcm_f32(source)
    o_rate, o_channels, o_chunks = engine.stream_pcm_f32(oracle)
    assert (rate, channels) == (o_rate, o_channels)
    assert np.array_equal(np.concatenate(list(chunks)), np.concatenate(list(o_chunks)))
    mono = np.concatenate(list(engine.stream_mono_f32(source, sample_rate=RATE)))
    assert np.array_equal(
        mono, np.concatenate(list(engine.stream_mono_f32(oracle, sample_rate=RATE)))
    )
    window = engine.decode_window_f32(source, 1000, 2000, rate, channels)
    assert window.size
    assert np.array_equal(window, engine.decode_window_f32(oracle, 1000, 2000, rate, channels))


def test_pcm_argv_keeps_the_map_after_the_duration_rewrite(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = media.single_stream_media(tmp_path)["wav"]
    engine = FFmpegEngine()
    argv = engine._pcm_f32_argv(path, RATE, 1)
    assert argv[argv.index("-i") + 2 : argv.index("-i") + 4] == ["-map", "0:a:0"]
    seen: list[list[str]] = []

    def spy(command, **kwargs):
        seen.append(list(command))
        return real_popen(command, **kwargs)

    real_popen = ffmpeg_module.popen
    monkeypatch.setattr(ffmpeg_module, "popen", spy)
    list(engine.stream_pcm_f32(path)[2])
    assert seen and "-progress" in seen[0]
    at = seen[0].index("-map")
    assert seen[0][at : at + 2] == ["-map", "0:a:0"]


def test_extract_segment_reads_first_stream(pair: tuple[Path, Path], tmp_path: Path) -> None:
    source, oracle = pair
    engine = FFmpegEngine()
    got = engine.extract_segment(source, tmp_path / "got.wav", 0.2, 1.2).read_bytes()
    expected = engine.extract_segment(oracle, tmp_path / "want.wav", 0.2, 1.2).read_bytes()
    assert got == expected
    muted = engine.extract_segment(
        source, tmp_path / "muted.wav", 0.2, 1.2, mute_spans=(MuteEnvelope(50.0, 51.0, 0.0, 0.0),)
    )
    assert muted.read_bytes() == got


def test_consolidate_writes_the_first_stream(tmp_path: Path, sample_wav: Path) -> None:
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    (audio_dir / "ref.wav").write_bytes(sample_wav.read_bytes())
    guest = media.multistream(audio_dir, "two_b.mkv")
    manifest_path = tmp_path / "ingest.yaml"
    manifest_path.write_text(
        "session:\n  reference_speaker: Ref\nspeakers:\n"
        f"  - name: Ref\n    sources: [ref.wav]\n  - name: Guest\n    sources: [{guest.name}]\n",
        encoding="utf-8",
    )
    result = consolidate_speakers(
        IngestManifest.load(manifest_path),
        audio_dir,
        tmp_path / "raw",
        analysis_start_sec=0.0,
        analysis_duration_sec=1.0,
    )
    oracle_dir = tmp_path / "oracle"
    oracle_dir.mkdir()
    only = media.first_stream_only(guest, oracle_dir)
    duration = FFmpegEngine().probe(guest).duration_sec
    expected = FFmpegEngine().extract_segment(only, tmp_path / "want.wav", 0.0, duration)
    assert result.speaker_tracks["Guest"].read_bytes() == expected.read_bytes()


def test_measure_loudness_blocks_reads_first_stream(pair: tuple[Path, Path]) -> None:
    source, oracle = pair
    engine = FFmpegEngine()
    got = engine.measure_loudness_blocks(source)
    assert got
    assert got == engine.measure_loudness_blocks(oracle)


def test_astats_and_loudness_read_first_stream(pair: tuple[Path, Path]) -> None:
    source, oracle = pair
    got = FFmpegEngine.astats(source)
    assert got["rms_level_db"] is not None
    assert got == FFmpegEngine.astats(oracle)
    engine = FFmpegEngine()
    loudness = engine.measure_loudness(source)
    assert loudness is not None
    assert loudness == engine.measure_loudness(oracle)


def test_full_loudness_keeps_ffmpeg_default_audio_stream(tmp_path: Path) -> None:
    source = media.multistream(tmp_path, "st.mkv")
    first = media.first_stream_only(source, tmp_path)
    selected = tmp_path / "selected.mkv"
    selected.write_bytes(_ffmpeg_bytes(source, "-map", "0:a:1", "-c", "copy", "-f", "matroska"))
    engine = FFmpegEngine()
    expected = engine.measure_loudness_full(selected)
    first_stats = engine.measure_loudness_full(first)
    assert expected is not None and first_stats is not None
    assert expected["integrated_lufs"] != first_stats["integrated_lufs"]
    assert engine.measure_loudness_full(source) == expected
    assert (
        engine.measure_loudness_full(source, on_progress=lambda *_: None, total_sec=2) == expected
    )


def test_single_stream_decodes_match_a_default_pick(
    single: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    engine = FFmpegEngine()
    layout = ffmpeg_mono_mean_layout(single)
    expected = np.frombuffer(
        _ffmpeg_bytes(single, *layout, "-ar", str(RATE), "-f", "f32le"), dtype=np.float32
    )
    assert np.array_equal(ungated_audio.load_mono_full(single, sample_rate=RATE), expected)
    with decoded_source.decoded_sources(RATE) as held:
        spool = held(single)
        assert np.array_equal(spool.read(0, spool.size), expected)
    streamed = np.concatenate(list(engine.stream_mono_f32(single, sample_rate=RATE)))
    assert np.array_equal(streamed, expected)
    if single.suffix != ".wav":
        seek = MediaSeek.at(0.25, lead_sec=0.0)
        raw = _ffmpeg_bytes(
            single, *seek.input_args(), *seek.output_args(0.5), *layout,
            "-ar", str(RATE), "-f", "f32le",
        )  # fmt: skip
        window = align.load_mono_window(single, start_sec=0.25, duration_sec=0.5, sample_rate=RATE)
        assert np.array_equal(window, np.frombuffer(raw, dtype=np.float32))
    got = engine.extract_segment(single, tmp_path / "got.wav", 0.2, 1.2)
    want = tmp_path / "want.wav"
    _extract_without_map(single, want, 0.2, 1.2)
    assert got.read_bytes() == want.read_bytes()
    assert engine.measure_loudness_blocks(single) == _loudness_blocks(single)
    mapped = (FFmpegEngine.astats(single), engine.measure_loudness(single))
    monkeypatch.setattr(ffmpeg_module, "run", _without_map(ffmpeg_module.run))
    assert mapped == (FFmpegEngine.astats(single), engine.measure_loudness(single))


def _without_map(real: Callable[..., Any]) -> Callable[..., Any]:
    def run(cmd: list[str], **kwargs: Any) -> Any:
        i = cmd.index("-map")
        return real([*cmd[:i], *cmd[i + 2 :]], **kwargs)

    return run


def _extract_without_map(source: Path, target: Path, start: float, end: float) -> None:
    seek = MediaSeek.at(start, lead_sec=0.0)
    subprocess.run(
        [
            FFmpegEngine().ffmpeg, "-y", "-threads", "1", *seek.input_args(), "-i", str(source),
            "-threads", "1", *seek.output_args(end - start), "-acodec", "pcm_s16le", str(target),
        ],
        check=True,
        capture_output=True,
    )  # fmt: skip


def test_video_only_media_still_fails_to_decode(tmp_path: Path) -> None:
    path = media.video_only(tmp_path)
    engine = FFmpegEngine()
    with pytest.raises((subprocess.CalledProcessError, NoAudioDecodedError)):
        ungated_audio.load_mono_full(path, sample_rate=RATE)
    with (
        decoded_source.decoded_sources(RATE) as held,
        pytest.raises((subprocess.CalledProcessError, NoAudioDecodedError)),
    ):
        held(path)
    with pytest.raises((subprocess.CalledProcessError, ValueError)):
        align.load_mono_window(path, start_sec=0.0, duration_sec=0.1, sample_rate=RATE)
    with pytest.raises((RuntimeError, ValueError)):
        list(engine.stream_mono_f32(path, sample_rate=RATE))
    with pytest.raises(subprocess.CalledProcessError):
        engine.extract_segment(path, tmp_path / "out.wav", 0.0, 0.1)
    assert engine.measure_loudness_blocks(path) == []
    assert set(FFmpegEngine.astats(path).values()) == {None}
    assert engine.measure_loudness(path) is None
    verdict = check_loudness(path, load_defaults())
    assert verdict["measured_lufs"] is None
    assert verdict["pass"] is False
