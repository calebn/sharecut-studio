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
from podcast_mcp.engines.whisper_device import choose_placement, describe_placement, whisper_vram_mb
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


@pytest.mark.parametrize(
    "message", ["CUDA out of memory", "Requested float16 compute type, but the device does not"]
)
def test_a_gpu_that_will_not_load_falls_back_to_the_cpu_once(planted, caplog, message) -> None:
    calls: list[str] = []

    def factory(name, **kwargs):
        calls.append(kwargs["device"])
        if kwargs["device"] == "cuda":
            raise RuntimeError(message)
        return MagicMock()

    engine = _engine()
    with use_hardware_profile(_gpu()), patch("faster_whisper.WhisperModel", factory):
        engine._get_model()
        engine._get_model()
    assert calls == ["cuda", "cpu"]
    assert sum("CPU for the life of this engine" in r.message for r in caplog.records) == 1
    assert message in caplog.text


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


@pytest.mark.parametrize("error", [CancelledProgress("stop")])
def test_cancel_does_not_trigger_a_fallback(planted, tmp_path, error) -> None:
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


def _run_with_gpu_error(tmp_path, error) -> list[str]:
    models = {"cuda": MagicMock(), "cpu": _words_model("hello")}
    models["cuda"].transcribe.side_effect = error
    made: list[str] = []

    def factory(name, **kwargs):
        made.append(kwargs["device"])
        return models[kwargs["device"]]

    audio = tmp_path / "a.wav"
    audio.write_bytes(b"x")
    with use_hardware_profile(_gpu()), patch("faster_whisper.WhisperModel", factory):
        _engine().transcribe_file(audio, language="en")
    return made


@pytest.mark.parametrize(
    "error", [RuntimeError("out of memory"), MemoryError("std::bad_alloc"), MemoryError()]
)
def test_a_host_out_of_memory_run_error_is_not_retried_on_the_cpu(planted, tmp_path, error) -> None:
    with pytest.raises(type(error)):
        _run_with_gpu_error(tmp_path, error)


def test_a_gpu_error_named_only_by_the_cause_falls_back(planted, tmp_path) -> None:
    try:
        raise ValueError("transcription failed") from RuntimeError("CUDA failed: out of memory")
    except ValueError as wrapped:
        assert _run_with_gpu_error(tmp_path, wrapped) == ["cuda", "cpu"]


def test_a_cyclic_cause_chain_terminates(planted, tmp_path) -> None:
    a, b = RuntimeError("one"), RuntimeError("two")
    a.__cause__, b.__cause__ = b, a
    with pytest.raises(RuntimeError, match="one"):
        _run_with_gpu_error(tmp_path, a)


def test_a_cancel_while_loading_does_not_fall_back(planted) -> None:
    calls: list[str] = []

    def factory(name, **kwargs):
        calls.append(kwargs["device"])
        raise CancelledProgress("stop")

    with use_hardware_profile(_gpu()), patch("faster_whisper.WhisperModel", factory):
        with pytest.raises(CancelledProgress):
            _engine()._get_model()
    assert calls == ["cuda"]


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


def test_an_unknown_device_is_refused() -> None:
    with pytest.raises(ValueError, match="Unknown Whisper device"):
        _engine("gpu")


def test_a_gpu_engine_does_not_redo_work_for_an_error_that_is_not_the_gpu(
    planted, tmp_path
) -> None:
    gpu = MagicMock()
    gpu.transcribe.side_effect = RuntimeError("could not decode the audio")
    made: list[str] = []

    def factory(name, **kwargs):
        made.append(kwargs["device"])
        return gpu

    audio = tmp_path / "a.wav"
    audio.write_bytes(b"x")
    with use_hardware_profile(_gpu()), patch("faster_whisper.WhisperModel", factory):
        with pytest.raises(RuntimeError, match="could not decode"):
            _engine().transcribe_file(audio, language="en")
    assert made == ["cuda"] and gpu.transcribe.call_count == 1


def test_a_gpu_that_fails_while_segments_are_being_read_is_redone_on_the_cpu(
    planted, tmp_path
) -> None:
    def broken_segments():
        yield MagicMock(
            text="a", start=0.0, end=0.5, words=[MagicMock(word="a", start=0.0, end=0.5)]
        )
        raise RuntimeError("CUDA out of memory")

    gpu = MagicMock()
    gpu.transcribe.return_value = (broken_segments(), MagicMock(duration=1.0))
    models = {"cuda": gpu, "cpu": _words_model("done")}
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"x")
    with (
        use_hardware_profile(_gpu()),
        patch("faster_whisper.WhisperModel", lambda n, **kw: models[kw["device"]]),
    ):
        transcript = _engine().transcribe_file(audio, language="en")
    assert [w.text for w in transcript.words] == ["done"]


def test_the_acoustic_word_check_stays_on_the_cpu(monkeypatch) -> None:
    from podcast_mcp.edits import acoustic_word

    seen: dict = {}
    real = TranscriptionEngine

    def spy(*args, **kwargs):
        seen.update(kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr("podcast_mcp.engines.transcribe.TranscriptionEngine", spy)
    acoustic_word.whisper_span_transcriber(load_defaults())
    assert seen["device"] == "cpu"


def test_the_memory_check_is_exact_at_the_boundary() -> None:
    need = whisper_vram_mb("large-v3")
    types = _types("float16")
    assert (
        choose_placement("large-v3", profile=_gpu(vram_mb=need), compute_types=types).device
        == "cuda"
    )
    assert (
        choose_placement("large-v3", profile=_gpu(vram_mb=need - 1), compute_types=types).device
        == "cpu"
    )


def test_a_cpu_redo_that_also_fails_raises_its_own_error(planted, tmp_path) -> None:
    models = {"cuda": MagicMock(), "cpu": MagicMock()}
    models["cuda"].transcribe.side_effect = RuntimeError("CUDA error")
    models["cpu"].transcribe.side_effect = RuntimeError("cpu decode failed")
    audio = tmp_path / "a.wav"
    audio.write_bytes(b"x")
    with (
        use_hardware_profile(_gpu()),
        patch("faster_whisper.WhisperModel", lambda n, **kw: models[kw["device"]]),
    ):
        with pytest.raises(RuntimeError, match="cpu decode failed"):
            _engine().transcribe_file(audio, language="en")


def test_the_doctor_line_says_where_speech_to_text_runs() -> None:
    text = describe_placement(
        "large-v3-turbo", profile=_gpu(), compute_types=_types("float16", "int8")
    )
    assert (
        text
        == "speech-to-text (large-v3-turbo) is set to run on the NVIDIA GPU; if the GPU fails it falls back to the CPU."
    )


def test_the_doctor_line_names_the_reason_when_a_gpu_is_too_small() -> None:
    text = describe_placement(
        "large-v3", profile=_gpu(vram_mb=2000), compute_types=_types("float16")
    )
    assert "runs on the CPU: the GPU has 2000 MB of memory" in text


def test_the_doctor_line_says_how_to_fix_a_gpu_the_engine_cannot_see() -> None:
    text = describe_placement("small", profile=_gpu(devices=0))
    assert "NVIDIA GPU is present but speech-to-text cannot use it" in text
    assert "update the NVIDIA driver" in text
    assert "CUDA 12 libraries (cuBLAS and cuDNN 9)" in text


def test_the_doctor_line_for_the_cpu_setting_and_for_no_gpu() -> None:
    assert "runs on the CPU because GPU use is turned off in settings" in describe_placement(
        "small", profile=_gpu(), preference="cpu"
    )
    assert describe_placement("small", profile=cpu_only_profile(4)) == (
        "speech-to-text (small) runs on the CPU."
    )


def test_podcast_doctor_prints_the_speech_to_text_placement(monkeypatch) -> None:
    from podcast_mcp.services.support.doctor import run_doctor_checks

    monkeypatch.delenv("PODCAST_WHISPER_MODEL", raising=False)
    with use_hardware_profile(_gpu(devices=0)):
        report = run_doctor_checks()
    messages = [check.message for check in report.checks]
    assert any("speech-to-text cannot use it" in m for m in messages), messages
