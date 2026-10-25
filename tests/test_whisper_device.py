"""Whisper runs on an NVIDIA GPU when it can and falls back to the CPU otherwise (#2248)."""

from __future__ import annotations

import dataclasses
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from model_pin_helpers import plant_pinned_whisper
from podcast_mcp.config.defaults import load_defaults
from podcast_mcp.engines.transcribe import TranscriptionEngine
from podcast_mcp.engines.whisper_device import choose_placement, whisper_vram_mb
from podcast_mcp.models import load_project
from podcast_mcp.util.hardware import (
    CPU_PROVIDER,
    CUDA_PROVIDER,
    CudaDevice,
    cpu_only_profile,
    use_hardware_profile,
)
from podcast_mcp.util.model_missing import ModelMissing
from podcast_mcp.util.progress import CancelledProgress


def _gpu(vram_mb: int | None = 12000, devices: int = 1):
    return dataclasses.replace(
        cpu_only_profile(8),
        system="Linux",
        cuda=CudaDevice("RTX 4070", vram_mb, "555.42"),
        onnx_providers=(CUDA_PROVIDER, CPU_PROVIDER),
        ctranslate2_cuda_devices=devices,
    )


def _types(*names: str):
    return lambda: names


@pytest.fixture(autouse=True)
def _auto(monkeypatch) -> None:
    monkeypatch.delenv("PODCAST_ACCELERATOR", raising=False)


@pytest.mark.parametrize(
    ("supported", "compute"),
    [
        (("float16", "int8_float16", "int8", "float32"), "float16"),
        (("int8_float16", "int8"), "int8_float16"),
        (("int8", "float32"), "int8"),
    ],
)
def test_a_usable_gpu_gets_the_best_number_format_it_supports(supported, compute) -> None:
    placement = choose_placement("large-v3-turbo", profile=_gpu(), compute_types=_types(*supported))
    assert (placement.device, placement.compute_type, placement.reason) == ("cuda", compute, None)


def test_no_gpu_means_the_cpu_without_a_complaint() -> None:
    placement = choose_placement("small", profile=cpu_only_profile(4))
    assert (placement.device, placement.compute_type, placement.reason) == ("cpu", "int8", None)


def test_the_cpu_setting_beats_a_gpu() -> None:
    placement = choose_placement(
        "small", profile=_gpu(), preference="cpu", compute_types=_types("float16")
    )
    assert placement.device == "cpu" and placement.reason is None


def test_a_gpu_with_too_little_memory_says_why() -> None:
    placement = choose_placement(
        "large-v3", profile=_gpu(vram_mb=2048), compute_types=_types("float16")
    )
    assert placement.device == "cpu"
    assert "2048 MB" in (placement.reason or "") and "large-v3" in (placement.reason or "")


def test_unknown_gpu_memory_is_not_a_reason_to_stay_on_the_cpu() -> None:
    placement = choose_placement(
        "large-v3", profile=_gpu(vram_mb=None), compute_types=_types("float16")
    )
    assert placement.device == "cuda"


def test_a_gpu_that_cannot_be_queried_or_has_no_format_stays_on_the_cpu() -> None:
    def broken():
        raise RuntimeError("driver mismatch")

    queried = choose_placement("small", profile=_gpu(), compute_types=broken)
    assert queried.device == "cpu" and "driver mismatch" in (queried.reason or "")
    none = choose_placement("small", profile=_gpu(), compute_types=_types("float32"))
    assert none.device == "cpu" and none.reason


@pytest.mark.parametrize(
    ("model", "mb"),
    [("tiny.en", 1000), ("small.en", 2000), ("large-v3-turbo", 3500), ("large-v3", 5500)],
)
def test_memory_estimate_by_model(model, mb) -> None:
    assert whisper_vram_mb(model) == mb


@pytest.fixture
def planted(tmp_path, monkeypatch) -> None:
    cache = tmp_path / "whisper"
    plant_pinned_whisper(cache, "tiny.en", monkeypatch)
    monkeypatch.setattr("podcast_mcp.config.defaults.whisper_cache_dir", lambda: cache)
    monkeypatch.setattr(
        "podcast_mcp.engines.whisper_device._cuda_compute_types",
        lambda: ("float16", "int8"),
    )


def _engine(device: str = "auto") -> TranscriptionEngine:
    return TranscriptionEngine("tiny.en", device=device, defaults=load_defaults())


def _words_model(text: str = "hi"):
    seg = MagicMock(text=text, start=0.0, end=0.5, words=[MagicMock(word=text, start=0.0, end=0.5)])
    model = MagicMock()
    model.transcribe.return_value = ([seg], MagicMock(duration=1.0))
    return model


def test_cpu_load_arguments_are_exactly_what_they_were_before(planted) -> None:
    calls: list[dict] = []

    def factory(name, **kwargs):
        calls.append(kwargs)
        return MagicMock()

    with use_hardware_profile(cpu_only_profile(4)), patch("faster_whisper.WhisperModel", factory):
        _engine()._get_model()
    assert [(c["device"], c["compute_type"], c["local_files_only"]) for c in calls] == [
        ("cpu", "int8", True)
    ]
    assert set(calls[0]) == {"device", "compute_type", "download_root", "local_files_only"}


def test_a_gpu_machine_loads_on_cuda(planted) -> None:
    calls: list[dict] = []

    def factory(name, **kwargs):
        calls.append(kwargs)
        return MagicMock()

    with use_hardware_profile(_gpu()), patch("faster_whisper.WhisperModel", factory):
        _engine()._get_model()
    assert [(c["device"], c["compute_type"]) for c in calls] == [("cuda", "float16")]


def test_an_explicit_cpu_engine_never_looks_at_the_gpu(planted) -> None:
    calls: list[dict] = []

    def factory(name, **kwargs):
        calls.append(kwargs)
        return MagicMock()

    with use_hardware_profile(_gpu()), patch("faster_whisper.WhisperModel", factory):
        _engine("cpu")._get_model()
    assert [c["device"] for c in calls] == ["cpu"]


def test_a_gpu_that_will_not_load_falls_back_to_the_cpu_once(planted, caplog) -> None:
    calls: list[str] = []

    def factory(name, **kwargs):
        calls.append(kwargs["device"])
        if kwargs["device"] == "cuda":
            raise RuntimeError("CUDA out of memory")
        return MagicMock()

    engine = _engine()
    with use_hardware_profile(_gpu()), patch("faster_whisper.WhisperModel", factory):
        engine._get_model()
        engine._get_model()
    assert calls == ["cuda", "cpu"]
    assert sum("CPU for the rest of this run" in r.message for r in caplog.records) == 1
    assert "out of memory" in caplog.text


def test_a_gpu_that_fails_mid_run_redoes_the_job_on_the_cpu(planted, tmp_path) -> None:
    models = {"cuda": MagicMock(), "cpu": _words_model("hello")}
    models["cuda"].transcribe.side_effect = RuntimeError("CUDA error: an illegal memory access")
    made: list[str] = []

    def factory(name, **kwargs):
        made.append(kwargs["device"])
        return models[kwargs["device"]]

    audio = tmp_path / "a.wav"
    audio.write_bytes(b"x")
    engine = _engine()
    with use_hardware_profile(_gpu()), patch("faster_whisper.WhisperModel", factory):
        transcript = engine.transcribe_file(audio, language="en")
        again = engine.transcribe_file(audio, language="en")
    assert [w.text for w in transcript.words] == ["hello"]
    assert [w.text for w in again.words] == ["hello"]
    assert made == ["cuda", "cpu"]


def test_samples_transcription_falls_back_too(planted) -> None:
    models = {"cuda": MagicMock(), "cpu": _words_model("yes")}
    models["cuda"].transcribe.side_effect = RuntimeError("CUDA failed")
    with (
        use_hardware_profile(_gpu()),
        patch("faster_whisper.WhisperModel", lambda n, **kw: models[kw["device"]]),
    ):
        text = _engine().transcribe_samples(np.zeros(1600, dtype=np.float32))
    assert text == "yes"


def test_a_cpu_error_is_not_swallowed(planted, tmp_path) -> None:
    model = MagicMock()
    model.transcribe.side_effect = RuntimeError("bad audio")
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"x")
    with (
        use_hardware_profile(cpu_only_profile(4)),
        patch("faster_whisper.WhisperModel", lambda n, **k: model),
    ):
        with pytest.raises(RuntimeError, match="bad audio"):
            _engine().transcribe_file(audio, language="en")
    assert model.transcribe.call_count == 1


@pytest.mark.parametrize("error", [CancelledProgress("stop"), KeyboardInterrupt()])
def test_cancel_and_interrupt_do_not_trigger_a_fallback(planted, tmp_path, error) -> None:
    gpu = MagicMock()
    gpu.transcribe.side_effect = error
    made: list[str] = []

    def factory(name, **kwargs):
        made.append(kwargs["device"])
        return gpu

    audio = tmp_path / "a.wav"
    audio.write_bytes(b"x")
    with use_hardware_profile(_gpu()), patch("faster_whisper.WhisperModel", factory):
        with pytest.raises(type(error)):
            _engine().transcribe_file(audio, language="en")
    assert made == ["cuda"]


def test_a_missing_model_is_reported_not_retried_on_the_cpu(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("podcast_mcp.config.defaults.whisper_cache_dir", lambda: tmp_path / "none")
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"x")
    with use_hardware_profile(_gpu()), pytest.raises(ModelMissing):
        _engine().transcribe_file(audio, language="en")


def test_the_transcript_cache_key_ignores_the_device(minimal_project, tmp_path: Path) -> None:
    project = load_project(minimal_project)
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"x")
    a = _engine("cpu").cache_path(project, "host", audio)
    b = _engine("auto").cache_path(project, "host", audio)
    assert a == b
