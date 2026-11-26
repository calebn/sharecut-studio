"""An English-only Whisper model refuses a non-English language on the desktop engine."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock

import numpy as np
import pytest

from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines import transcribe as transcribe_module
from podcast_mcp.engines.models.whisper import english_only_whisper
from podcast_mcp.engines.transcribe import TranscribeJob, TranscriptionEngine
from podcast_mcp.util.coded_error import CodedValueError

MESSAGE = (
    "The transcription model tiny.en reads English only, so it can't transcribe "
    "language 'de'. Set the language to English or use a multilingual model."
)


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("tiny.en", True),
        ("base.en", True),
        ("small.en", True),
        ("medium.en", True),
        ("distil-medium.en", True),
        ("distil-small.en", True),
        ("distil-large-v2", True),
        ("distil-large-v3", True),
        ("tiny", False),
        ("small", False),
        ("large-v3", False),
        ("large-v3-turbo", False),
        ("distil-large-v3.5", False),
        ("", False),
    ],
)
def test_english_only_whisper_truth_table(name: str, expected: bool) -> None:
    assert english_only_whisper(name) is expected


def _engine(monkeypatch: pytest.MonkeyPatch, size: str = "tiny.en") -> TranscriptionEngine:
    monkeypatch.setattr(transcribe_module, "_transcription_backend", lambda: "faster_whisper")
    engine = TranscriptionEngine(model_size=size, device="cpu", defaults=load_defaults())
    load = Mock(side_effect=AssertionError("the model was touched"))
    monkeypatch.setattr(engine, "_get_model", load)
    monkeypatch.setattr(engine, "_load_model", load)
    return engine


def _job(tmp_path: Path) -> TranscribeJob:
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"RIFF")
    return TranscribeJob(track_id="a", source_id=None, audio=audio)


def _no_cache_touch(monkeypatch: pytest.MonkeyPatch) -> Mock:
    touched = Mock(side_effect=AssertionError("the cache was read"))
    monkeypatch.setattr(transcribe_module, "_read_cache", touched)
    return touched


def _refused(call) -> CodedValueError:
    with pytest.raises(CodedValueError) as caught:
        call()
    return caught.value


def test_transcribe_samples_refuses_before_loading_the_model(monkeypatch) -> None:
    engine = _engine(monkeypatch)
    err = _refused(lambda: engine.transcribe_samples(np.zeros(1600), language="de"))
    assert err.code == "transcription_language_unsupported"
    assert str(err) == MESSAGE


def test_transcribe_file_refuses_before_loading_the_model(monkeypatch, tmp_path) -> None:
    engine = _engine(monkeypatch)
    err = _refused(lambda: engine.transcribe_file(tmp_path / "a.wav", language="de"))
    assert err.code == "transcription_language_unsupported"


def test_transcribe_job_refuses_before_any_cache_read(monkeypatch, tmp_path) -> None:
    engine = _engine(monkeypatch)
    touched = _no_cache_touch(monkeypatch)
    err = _refused(lambda: engine.transcribe_job(Mock(), _job(tmp_path), language="de"))
    assert err.code == "transcription_language_unsupported"
    touched.assert_not_called()


def test_read_asr_cache_only_reads_so_it_does_not_refuse(monkeypatch, tmp_path) -> None:
    engine = _engine(monkeypatch)
    cached = object()
    monkeypatch.setattr(transcribe_module, "_read_cache", lambda path: cached)
    monkeypatch.setattr(engine, "cache_path", lambda *a, **k: tmp_path / "c.json")
    monkeypatch.setattr(transcribe_module, "guard_transcript", lambda t: None)
    cache, transcript = engine.read_asr_cache(
        Mock(), _job(tmp_path), language="de", initial_prompt=None, audio_sha256="x"
    )
    assert cache == tmp_path / "c.json"
    assert transcript is cached


def test_transcribe_job_refuses_before_hashing_the_audio(monkeypatch, tmp_path) -> None:
    engine = _engine(monkeypatch)
    hashed = Mock(side_effect=AssertionError("the audio was hashed"))
    monkeypatch.setattr(transcribe_module, "sha256_file", hashed)
    err = _refused(lambda: engine.transcribe_job(Mock(), _job(tmp_path), language="de"))
    assert err.code == "transcription_language_unsupported"
    hashed.assert_not_called()


def test_transcribe_all_dialogue_refuses_before_the_pool_starts(monkeypatch, tmp_path) -> None:
    engine = _engine(monkeypatch)
    pool = Mock(side_effect=AssertionError("the pool started"))
    monkeypatch.setattr(transcribe_module, "run_jobs_concurrently", pool)
    monkeypatch.setattr(engine, "_concurrent_workers", lambda count: 4)
    jobs = [_job(tmp_path), _job(tmp_path)]
    err = _refused(lambda: engine.transcribe_all_dialogue(Mock(), language="de", jobs=jobs))
    assert err.code == "transcription_language_unsupported"
    pool.assert_not_called()


@pytest.mark.parametrize("language", [None, "auto", "en", "en-US"])
def test_english_requests_pass_on_an_english_only_model(monkeypatch, language) -> None:
    engine = _engine(monkeypatch)
    engine._require_supported_language(language)


@pytest.mark.parametrize("size", ["small", "large-v3"])
def test_a_multilingual_model_accepts_german(monkeypatch, size) -> None:
    engine = _engine(monkeypatch, size)
    engine._require_supported_language("de")


@pytest.mark.parametrize("size", ["distil-large-v2", "distil-large-v3"])
def test_distil_models_refuse_german(monkeypatch, size) -> None:
    engine = _engine(monkeypatch, size)
    with pytest.raises(CodedValueError) as caught:
        engine._require_supported_language("de")
    assert caught.value.code == "transcription_language_unsupported"


def test_the_whisper_cpp_backend_leaves_the_check_to_its_own_path(monkeypatch) -> None:
    engine = _engine(monkeypatch)
    engine.backend = "whisper_cpp"
    engine._require_supported_language("de")


def test_an_english_probe_on_an_english_only_model_reaches_the_model(monkeypatch) -> None:
    engine = _engine(monkeypatch)
    reached = Mock(side_effect=RuntimeError("reached the model"))
    monkeypatch.setattr(engine, "_get_model", reached)
    with pytest.raises(RuntimeError, match="reached the model"):
        engine.transcribe_samples(np.zeros(1600), language="en-US")
    reached.assert_called()
