"""TranscriptionEngine picks the whisper.cpp backend from the host row."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import whisper_cpp
from podcast_mcp.engines.ffmpeg import FFmpegEngine
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.models import Transcript, TranscriptWord, load_project
from podcast_mcp.util import native_whisper
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.host_platform import IOS, MACOS


@pytest.fixture
def ios_engine(host, monkeypatch: pytest.MonkeyPatch) -> TranscriptionEngine:
    host(IOS)
    monkeypatch.setattr(native_whisper, "is_installed", lambda: True)
    return TranscriptionEngine(defaults=load_defaults())


def test_a_whisper_cpp_host_without_the_backend_refuses_with_the_host_sentence(
    host, monkeypatch
) -> None:
    host(IOS)
    monkeypatch.setattr(native_whisper, "is_installed", lambda: False)
    with pytest.raises(CodedValueError, match="can't transcribe audio on this device") as refused:
        TranscriptionEngine(defaults=load_defaults())
    assert refused.value.code == "transcription_unavailable"


def test_a_desktop_host_keeps_faster_whisper(host) -> None:
    host(MACOS)
    assert TranscriptionEngine(defaults=load_defaults()).backend == "faster_whisper"


def test_the_backend_is_part_of_the_cache_key(
    host, monkeypatch, minimal_project, tmp_path: Path
) -> None:
    project = load_project(minimal_project)
    audio = tmp_path / "recording.wav"
    audio.write_bytes(b"recording")
    host(MACOS)
    desktop = TranscriptionEngine(model_size="base.en", defaults=load_defaults())
    desktop_cache = desktop.cache_path(project, "host", audio)
    host(IOS)
    monkeypatch.setattr(native_whisper, "is_installed", lambda: True)
    phone = TranscriptionEngine(model_size="base.en", defaults=load_defaults())
    assert phone.backend == "whisper_cpp"
    monkeypatch.setenv("WHISPER_CPP_MODEL_NAME", "base.en")
    assert phone._cache_model_key() == desktop._cache_model_key()
    assert phone.cache_path(project, "host", audio) != desktop_cache


def test_the_cache_key_follows_the_installed_model_file(
    ios_engine, monkeypatch, minimal_project, tmp_path: Path
) -> None:
    project = load_project(minimal_project)
    audio = tmp_path / "recording.wav"
    audio.write_bytes(b"recording")
    monkeypatch.delenv("WHISPER_CPP_MODEL_NAME", raising=False)
    small = ios_engine.cache_path(project, "host", audio)
    monkeypatch.setenv("WHISPER_CPP_MODEL_NAME", "ggml-base.en.bin")
    assert ios_engine.cache_path(project, "host", audio) != small


def test_transcribe_file_decodes_to_a_16k_mono_wav_and_runs_whisper_cpp(
    ios_engine, monkeypatch, tmp_path: Path
) -> None:
    source = tmp_path / "talk.m4a"
    source.write_bytes(b"audio")
    seen: dict[str, object] = {}

    def stream(self, path, *, sample_rate, chunk_frames=0):
        seen["decoded"] = (path, sample_rate)
        yield np.full(8000, 0.5, dtype=np.float32)
        yield np.full(8000, -0.5, dtype=np.float32)

    def fake_whisper(wav: Path, **kwargs) -> Transcript:
        with wave.open(str(wav)) as fh:
            seen["wav"] = (fh.getframerate(), fh.getnchannels(), fh.getnframes())
        seen["kwargs"] = kwargs
        return Transcript(
            track_id="", language="en", words=[TranscriptWord(text="hi", start=0.0, end=0.4)]
        )

    monkeypatch.setattr(FFmpegEngine, "stream_mono_f32", stream)
    monkeypatch.setattr(whisper_cpp, "transcribe_file_whisper_cpp", fake_whisper)

    transcript = ios_engine.transcribe_file(source, language="en-US", initial_prompt="names")

    assert seen["decoded"] == (source, 16_000)
    assert seen["wav"] == (16_000, 1, 16_000)
    assert seen["kwargs"] == {
        "language": "en-US",
        "initial_prompt": "names",
        "max_word_sec": 2.0,
    }
    assert [w.text for w in transcript.words] == ["hi"]
    assert transcript.asr_language == "en"
    assert transcript.word_aligner is None
    assert transcript.alignment_score_method is None


def test_transcribe_samples_writes_a_temp_wav_and_joins_the_words(ios_engine, monkeypatch) -> None:
    seen: dict[str, object] = {}

    def fake_whisper(wav: Path, **kwargs) -> Transcript:
        with wave.open(str(wav)) as fh:
            seen["wav"] = (fh.getframerate(), fh.getnchannels(), fh.getnframes())
        seen["path"] = wav
        return Transcript(
            track_id="",
            language="en",
            words=[
                TranscriptWord(text="uh", start=0.0, end=0.2),
                TranscriptWord(text="huh", start=0.2, end=0.4),
            ],
        )

    monkeypatch.setattr(whisper_cpp, "transcribe_file_whisper_cpp", fake_whisper)
    monkeypatch.setattr(
        TranscriptionEngine, "_get_model", lambda self: pytest.fail("loaded faster-whisper")
    )

    heard = ios_engine.transcribe_samples(np.zeros(3200, dtype=np.float32), language="en")

    assert heard == "uh huh"
    assert seen["wav"] == (16_000, 1, 3200)
    assert not Path(str(seen["path"])).exists()
