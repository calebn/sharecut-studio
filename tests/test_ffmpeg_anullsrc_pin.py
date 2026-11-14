"""Pin the exact ``anullsrc`` source expression each FFmpegEngine site produces."""

from __future__ import annotations

import wave
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from podcast_mcp.engines.audio import SequenceAudio, SilenceAudio, SourceAudio
from podcast_mcp.engines.ffmpeg import AudioProbe, FFmpegEngine


def _wav(path: Path) -> Path:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"\0\0" * 8000)
    return path


@pytest.mark.parametrize(
    ("rate", "channels", "expected"),
    [(44100, 1, "mono"), (48000, 2, "stereo"), (16000, 0, "mono"), (48000, 6, "stereo")],
)
def test_concat_with_gap_anullsrc_is_mono_up_to_one_channel_else_stereo(
    tmp_path: Path, rate: int, channels: int, expected: str
):
    eng = FFmpegEngine()
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        eng.concat_with_gap(
            tmp_path / "a.wav", tmp_path / "b.wav", tmp_path / "o.wav",
            gap_sec=0.5, rate=rate, channels=channels,
        )  # fmt: skip
    argv = run.call_args_list[0].args[0]
    assert argv[:6] == [eng.ffmpeg, "-y", "-f", "lavfi", "-i", f"anullsrc=r={rate}:cl={expected}"]
    assert argv[6:8] == ["-t", "0.500000"]


@pytest.mark.parametrize(
    ("kwargs", "source"),
    [
        ({}, "anullsrc=r=48000:cl=2c"),
        ({"sample_rate": 44100, "channels": 1}, "anullsrc=r=44100:cl=1c"),
        ({"sample_rate": 16000, "channels": 6}, "anullsrc=r=16000:cl=6c"),
    ],
)
def test_silence_anullsrc_names_the_channel_count_as_nc(tmp_path: Path, kwargs: dict, source: str):
    eng = FFmpegEngine()
    out = tmp_path / "sub" / "s.wav"
    with patch("podcast_mcp.engines.ffmpeg.run") as run:
        assert eng.silence(out, 1.5, **kwargs) == out
    assert run.call_args.args[0] == [
        eng.ffmpeg, "-y", "-f", "lavfi", "-i", source,
        "-t", "1.5", "-c:a", "pcm_s16le", str(out),
    ]  # fmt: skip
    assert run.call_args.kwargs == {"check": True}


@pytest.mark.parametrize(
    ("rate", "channels", "source"),
    [(44100, 1, "anullsrc=r=44100:cl=1c"), (48000, 2, "anullsrc=r=48000:cl=2c")],
)
def test_render_timeline_silence_node_pins_anullsrc_then_atrim(
    tmp_path: Path, rate: int, channels: int, source: str
):
    eng = FFmpegEngine()
    src = _wav(tmp_path / "src.wav")
    probe = AudioProbe(1.0, rate, channels, audio_start_sec=0.0, rebases_audio_reads=False)
    audio = SequenceAudio(SourceAudio(src, 0.0, 1.0), (SilenceAudio(0.25),))
    with (
        patch.object(eng, "probe", return_value=probe),
        patch.object(eng, "audio_start_sec", return_value=0.0),
        patch("podcast_mcp.engines.ffmpeg.run", return_value=MagicMock(returncode=0)) as run,
    ):
        eng.render_timeline(tmp_path / "o.wav", audio, "anull")
    argv = run.call_args.args[0]
    graph = argv[argv.index("-filter_complex") + 1]
    assert f"{source},atrim=end_sample={int(0.25 * rate)}[node0]" in graph.split(";")
