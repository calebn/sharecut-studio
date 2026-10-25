"""The shared ONNX session helper: provider order, CPU fallback, and the models still on the CPU (#2249)."""

from __future__ import annotations

import dataclasses
import sys
from types import SimpleNamespace
from typing import ClassVar

import numpy as np
import pytest

from podcast_mcp.engines import onnx_session
from podcast_mcp.engines.onnx_session import OnnxModel, provider_order
from podcast_mcp.util.hardware import (
    COREML_PROVIDER,
    CPU_PROVIDER,
    cpu_only_profile,
    use_hardware_profile,
)


def _apple():
    return dataclasses.replace(
        cpu_only_profile(8),
        system="Darwin",
        machine="arm64",
        apple_silicon=True,
        onnx_providers=(COREML_PROVIDER, CPU_PROVIDER),
    )


class _Session:
    built: ClassVar[list[dict]] = []
    fail_load: ClassVar[set[str]] = set()
    fail_run: ClassVar[set[str]] = set()

    def __init__(self, path, sess_options, providers) -> None:
        self.path = path
        self.opts = sess_options
        self.providers = list(providers)
        type(self).built.append({"providers": self.providers, "opts": sess_options})
        if self.providers[0] in type(self).fail_load:
            raise RuntimeError(f"{self.providers[0]} cannot load")

    def get_providers(self):
        return self.providers

    def get_inputs(self):
        return [SimpleNamespace(name="x")]

    def run(self, names, feed):
        if self.providers[0] in type(self).fail_run:
            raise RuntimeError("accelerator failed")
        return [f"ran on {self.providers[0]}"]


@pytest.fixture(autouse=True)
def fake_ort(monkeypatch):
    monkeypatch.delenv("PODCAST_ACCELERATOR", raising=False)
    _Session.built = []
    _Session.fail_load = set()
    _Session.fail_run = set()
    onnx_session._failed.clear()
    fake = SimpleNamespace(SessionOptions=lambda: SimpleNamespace(), InferenceSession=_Session)
    monkeypatch.setitem(sys.modules, "onnxruntime", fake)
    yield
    onnx_session._failed.clear()


def test_a_model_that_did_not_ask_for_acceleration_runs_on_the_cpu_only() -> None:
    with use_hardware_profile(_apple()):
        model = OnnxModel("m.onnx")
    assert _Session.built[0]["providers"] == [CPU_PROVIDER]
    assert model.run(None, {}) == [f"ran on {CPU_PROVIDER}"]


def test_the_options_are_threads_and_quiet_logging_only_when_asked() -> None:
    OnnxModel("a.onnx", threads=3, quiet=True)
    OnnxModel("b.onnx")
    first, second = (b["opts"] for b in _Session.built)
    assert first.intra_op_num_threads == 3 and first.log_severity_level == 3
    assert not hasattr(second, "intra_op_num_threads") and not hasattr(second, "log_severity_level")


def test_an_accelerated_model_tries_the_best_provider_with_the_cpu_last() -> None:
    with use_hardware_profile(_apple()):
        OnnxModel("m.onnx", accelerate=True)
    assert _Session.built[0]["providers"] == [COREML_PROVIDER, CPU_PROVIDER]


def test_the_cpu_setting_beats_acceleration() -> None:
    with use_hardware_profile(_apple()):
        assert provider_order(accelerate=True, preference="cpu") == (CPU_PROVIDER,)


def test_an_accelerated_model_on_a_cpu_only_machine_uses_the_cpu() -> None:
    with use_hardware_profile(cpu_only_profile(4)):
        OnnxModel("m.onnx", accelerate=True)
    assert [b["providers"] for b in _Session.built] == [[CPU_PROVIDER]]


def test_an_accelerator_that_will_not_load_is_replaced_by_the_cpu_and_remembered(caplog) -> None:
    _Session.fail_load = {COREML_PROVIDER}
    with use_hardware_profile(_apple()):
        first = OnnxModel("m.onnx", accelerate=True)
        second = OnnxModel("m.onnx", accelerate=True)
    assert first.providers == [CPU_PROVIDER] or first.providers == (CPU_PROVIDER,)
    assert [b["providers"][0] for b in _Session.built] == [
        COREML_PROVIDER,
        CPU_PROVIDER,
        CPU_PROVIDER,
    ]
    assert sum("runs on the CPU for this process" in r.message for r in caplog.records) == 1
    assert second.run(None, {}) == [f"ran on {CPU_PROVIDER}"]


def test_an_accelerator_that_fails_while_running_is_replaced_and_the_call_is_retried() -> None:
    _Session.fail_run = {COREML_PROVIDER}
    with use_hardware_profile(_apple()):
        model = OnnxModel("m.onnx", accelerate=True)
        assert model.run(None, {}) == [f"ran on {CPU_PROVIDER}"]
        assert model.run(None, {}) == [f"ran on {CPU_PROVIDER}"]
        again = OnnxModel("m.onnx", accelerate=True)
    assert [b["providers"][0] for b in _Session.built] == [
        COREML_PROVIDER,
        CPU_PROVIDER,
        CPU_PROVIDER,
    ]
    assert again.run(None, {}) == [f"ran on {CPU_PROVIDER}"]


def test_a_cpu_error_is_raised_not_retried() -> None:
    _Session.fail_run = {CPU_PROVIDER}
    model = OnnxModel("m.onnx")
    with pytest.raises(RuntimeError, match="accelerator failed"):
        model.run(None, {})
    assert len(_Session.built) == 1


def test_a_cpu_load_error_is_raised() -> None:
    _Session.fail_load = {CPU_PROVIDER}
    with pytest.raises(RuntimeError, match="cannot load"):
        OnnxModel("m.onnx")


def test_the_real_models_stay_on_the_cpu_until_the_lab_says_otherwise() -> None:
    from podcast_mcp.engines import word_align
    from podcast_mcp.engines.models import speaker_ecapa

    assert word_align.ACCELERATE_ALIGNER is False
    assert speaker_ecapa.ACCELERATE_ECAPA is False


def test_a_real_session_runs_a_model_on_the_cpu(tmp_path, monkeypatch) -> None:
    onnx = pytest.importorskip("onnx")
    pytest.importorskip("onnxruntime")
    monkeypatch.undo()
    from onnx import TensorProto as T
    from onnx import helper as h

    graph = h.make_graph(
        [h.make_node("Neg", ["x"], ["y"])],
        "g",
        [h.make_tensor_value_info("x", T.FLOAT, ["n"])],
        [h.make_tensor_value_info("y", T.FLOAT, ["n"])],
    )
    model = h.make_model(graph, opset_imports=[h.make_opsetid("", 13)])
    model.ir_version = 8
    path = tmp_path / "neg.onnx"
    onnx.save(model, path)
    out = OnnxModel(path, threads=1, quiet=True).run(None, {"x": np.array([1.0, -2.0], np.float32)})
    assert out[0].tolist() == [-1.0, 2.0]
