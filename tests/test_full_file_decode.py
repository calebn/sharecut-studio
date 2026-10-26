from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pytest

from podcast_mcp.engines import ffmpeg, ungated_audio
from podcast_mcp.util import process
from podcast_mcp.util.batch_scope import batch_scope
from podcast_mcp.util.binaries import FFmpegPair, FFmpegPairResolutionError
from podcast_mcp.util.pcm_stream import NoAudioDecodedError


@pytest.fixture
def admitted(monkeypatch: pytest.MonkeyPatch) -> list[str | None]:
    selectors: list[str | None] = []

    def resolve(ffmpeg: str | None = None, ffprobe: str | None = None) -> FFmpegPair:
        selectors.append(ffmpeg)
        return FFmpegPair("/admitted/ffmpeg", "/admitted/ffprobe", (9, 0, 2), "explicit")

    monkeypatch.setattr(ffmpeg, "resolve_ffmpeg_pair", resolve)
    return selectors


@pytest.mark.parametrize("layout", [[], ["-ac", "1"], ["-af", "pan=mono|c0=0.5*c0+0.5*c1"]])
@pytest.mark.parametrize("sample_rate", [8000, 16000, 48000])
def test_full_decode_preserves_command_and_float32_bytes(
    monkeypatch: pytest.MonkeyPatch, admitted: list[str | None], layout: list[str], sample_rate: int
) -> None:
    payload = np.array([0, 0x80000000, 0x3F800000, 0x7FC00001], dtype=np.uint32).tobytes()
    run = MagicMock(return_value=process.CompletedProcess([], 0, payload, b""))
    monkeypatch.setattr(ffmpeg, "run", run)
    path = Path("source with spaces.wav")
    samples = ffmpeg.FFmpegEngine(ffmpeg="chosen-ffmpeg").decode_full_f32(
        path, sample_rate=sample_rate, layout=layout
    )
    run.assert_called_once_with(
        [
            "/admitted/ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-map",
            "0:a:0",
            *layout,
            "-ar",
            str(sample_rate),
            "-f",
            "f32le",
            "pipe:1",
        ],
        capture_output=True,
        check=True,
    )
    assert admitted == ["chosen-ffmpeg"]
    assert samples.shape == (4,)
    assert samples.dtype == np.float32
    assert samples.tobytes() == payload
    assert samples.base is payload
    assert not samples.flags.writeable


def test_full_decode_rejects_empty_success_and_does_not_cache_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, admitted: list[str | None]
) -> None:
    path = tmp_path / "source.wav"
    path.write_bytes(b"source")
    run = MagicMock(
        side_effect=[
            process.CompletedProcess([], 0, b"", b""),
            process.CompletedProcess([], 0, bytes(4), b""),
        ]
    )
    monkeypatch.setattr(ffmpeg, "run", run)
    with batch_scope():
        with pytest.raises(NoAudioDecodedError, match="no audio decoded"):
            ungated_audio._decode_f32(path, 8000, None, [])
        assert ungated_audio._decode_f32(path, 8000, None, []).size == 1
    assert run.call_count == 2
    assert admitted == [None, None]


@pytest.mark.parametrize(
    "failure",
    [
        process.CalledProcessError(7, ["decode"], b"partial", b"bad"),
        KeyboardInterrupt(),
        FFmpegPairResolutionError("unavailable"),
    ],
)
def test_full_decode_preserves_failure_identity(
    monkeypatch: pytest.MonkeyPatch, admitted: list[str | None], failure: BaseException
) -> None:
    run = MagicMock(side_effect=failure)
    monkeypatch.setattr(ffmpeg, "run", run)
    with pytest.raises(type(failure)) as caught:
        ffmpeg.FFmpegEngine().decode_full_f32(Path("source.wav"), sample_rate=8000, layout=[])
    assert caught.value is failure


def test_full_decode_admits_only_on_cache_misses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, admitted: list[str | None]
) -> None:
    path = tmp_path / "source.wav"
    path.write_bytes(b"source")
    run = MagicMock(return_value=process.CompletedProcess([], 0, bytes(8), b""))
    monkeypatch.setattr(ffmpeg, "run", run)
    with batch_scope():
        first = ungated_audio._decode_f32(path, 8000, None, [])
        assert ungated_audio._decode_f32(path, 8000, None, []) is first
        ungated_audio._decode_f32(path, 8000, "explicit", [])
        ungated_audio._decode_f32(path, 16000, None, [])
        ungated_audio._decode_f32(path, 8000, None, ["-ac", "1"])
    assert admitted == [None, "explicit", None, None]
    assert run.call_count == 4


def test_full_decode_interrupt_kills_its_child(
    monkeypatch: pytest.MonkeyPatch, admitted: list[str | None]
) -> None:
    child = MagicMock()
    child.__enter__.return_value = child
    failure = KeyboardInterrupt()
    child.communicate.side_effect = failure
    monkeypatch.setattr(process, "_spawn", MagicMock(return_value=child))
    with pytest.raises(KeyboardInterrupt) as caught:
        ffmpeg.FFmpegEngine().decode_full_f32(Path("source.wav"), sample_rate=8000, layout=[])
    assert caught.value is failure
    child.kill.assert_called_once_with()


def test_full_decode_preserves_binary_admission_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    failure = FFmpegPairResolutionError("selected binary is unavailable")
    resolve = MagicMock(side_effect=failure)
    run = MagicMock()
    monkeypatch.setattr(ffmpeg, "resolve_ffmpeg_pair", resolve)
    monkeypatch.setattr(ffmpeg, "run", run)
    with pytest.raises(FFmpegPairResolutionError) as caught:
        ffmpeg.FFmpegEngine(ffmpeg="selected").decode_full_f32(
            Path("source.wav"), sample_rate=8000, layout=[]
        )
    assert caught.value is failure
    run.assert_not_called()


def test_full_decode_preserves_malformed_float32_failure(
    monkeypatch: pytest.MonkeyPatch, admitted: list[str | None]
) -> None:
    run = MagicMock(return_value=process.CompletedProcess([], 0, b"bad", b""))
    monkeypatch.setattr(ffmpeg, "run", run)
    with pytest.raises(ValueError, match="buffer size must be a multiple"):
        ffmpeg.FFmpegEngine().decode_full_f32(Path("source.wav"), sample_rate=8000, layout=[])
