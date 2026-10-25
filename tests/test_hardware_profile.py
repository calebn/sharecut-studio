"""The hardware probe (#2247): fake profiles per platform, never-raising, honest fallbacks."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from podcast_mcp.util import hardware
from podcast_mcp.util.hardware import (
    COREML_PROVIDER,
    CPU_PROVIDER,
    CUDA_PROVIDER,
    DIRECTML_PROVIDER,
    CudaDevice,
    HardwareProfile,
    accelerator_preference,
    cgroup_cpu_limit,
    cpu_only_profile,
    effective_cpu_count,
    hardware_profile,
    probe_hardware,
    use_hardware_profile,
)


def _profile(**kw) -> HardwareProfile:
    base = cpu_only_profile(8)
    fields = {**base.__dict__, **kw}
    return HardwareProfile(**fields)


NVIDIA = _profile(
    system="Linux",
    cuda=CudaDevice("RTX 4070", 12282, "555.42"),
    onnx_providers=(CUDA_PROVIDER, CPU_PROVIDER),
    ctranslate2_cuda_devices=1,
)
APPLE = _profile(
    system="Darwin",
    machine="arm64",
    apple_silicon=True,
    onnx_providers=(COREML_PROVIDER, CPU_PROVIDER),
)
WINDOWS = _profile(
    system="Windows", directml=True, onnx_providers=(DIRECTML_PROVIDER, CPU_PROVIDER)
)


@pytest.mark.parametrize(
    ("profile", "order", "words"),
    [
        (NVIDIA, (CUDA_PROVIDER, CPU_PROVIDER), "NVIDIA GPU (RTX 4070)"),
        (APPLE, (COREML_PROVIDER, CPU_PROVIDER), "Apple Silicon"),
        (WINDOWS, (DIRECTML_PROVIDER, CPU_PROVIDER), "DirectML"),
        (cpu_only_profile(8), (CPU_PROVIDER,), "No GPU found"),
    ],
)
def test_provider_order_and_summary_per_platform(profile, order, words) -> None:
    assert profile.onnx_provider_order("auto") == order
    assert words in profile.summary("auto")


def test_cuda_outranks_coreml_and_directml_and_cpu_is_always_last() -> None:
    mixed = _profile(
        onnx_providers=(DIRECTML_PROVIDER, COREML_PROVIDER, CUDA_PROVIDER),
        cuda=CudaDevice("RTX 4070", 12000, "550.1"),
        apple_silicon=True,
        directml=True,
    )
    assert mixed.onnx_provider_order() == (
        CUDA_PROVIDER,
        COREML_PROVIDER,
        DIRECTML_PROVIDER,
        CPU_PROVIDER,
    )


@pytest.mark.parametrize("profile", [NVIDIA, APPLE, WINDOWS])
def test_cpu_preference_leaves_only_the_cpu_provider(profile) -> None:
    assert profile.onnx_provider_order("cpu") == (CPU_PROVIDER,)
    assert "turned off" in profile.summary("cpu")


def test_summary_counts_cores_in_plain_words() -> None:
    capped = _profile(logical_cores=8, effective_cores=2)
    assert "2 usable CPU cores of 8" in capped.summary()
    assert "1 usable CPU core." in _profile(effective_cores=1, logical_cores=1).summary()


def test_to_dict_is_json_ready_and_carries_the_decision() -> None:
    out = NVIDIA.to_dict("auto")
    assert out["onnx_provider_order"] == [CUDA_PROVIDER, CPU_PROVIDER]
    assert out["preference"] == "auto"
    assert out["cuda"]["name"] == "RTX 4070"
    assert out["summary"].startswith("NVIDIA GPU")


def test_preference_env_beats_config_and_junk_falls_back_to_auto(monkeypatch) -> None:
    monkeypatch.delenv("PODCAST_ACCELERATOR", raising=False)
    assert accelerator_preference(None) == "auto"
    assert accelerator_preference({"performance": {"accelerator": "cpu"}}) == "cpu"
    assert accelerator_preference({"performance": {"accelerator": "tpu"}}) == "auto"
    assert accelerator_preference({"performance": None}) == "auto"
    monkeypatch.setenv("PODCAST_ACCELERATOR", " CPU ")
    assert accelerator_preference({"performance": {"accelerator": "auto"}}) == "cpu"
    monkeypatch.setenv("PODCAST_ACCELERATOR", "gpu")
    assert accelerator_preference({"performance": {"accelerator": "cpu"}}) == "cpu"


def test_cgroup_v2_and_v1_quota_in_cores(tmp_path: Path) -> None:
    (tmp_path / "cpu.max").write_text("150000 100000\n")
    assert cgroup_cpu_limit(tmp_path) == 1.5
    (tmp_path / "cpu.max").write_text("max 100000\n")
    assert cgroup_cpu_limit(tmp_path) is None
    v1 = tmp_path / "v1"
    (v1 / "cpu").mkdir(parents=True)
    (v1 / "cpu" / "cpu.cfs_quota_us").write_text("200000\n")
    (v1 / "cpu" / "cpu.cfs_period_us").write_text("100000\n")
    assert cgroup_cpu_limit(v1) == 2.0
    (v1 / "cpu" / "cpu.cfs_quota_us").write_text("-1\n")
    assert cgroup_cpu_limit(v1) is None
    assert cgroup_cpu_limit(tmp_path / "missing") is None


def test_effective_cores_take_the_smallest_of_logical_affinity_and_quota(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(hardware.os, "process_cpu_count", lambda: 6, raising=False)
    assert effective_cpu_count(8, tmp_path) == 6
    (tmp_path / "cpu.max").write_text("250000 100000\n")
    assert effective_cpu_count(8, tmp_path) == 3
    (tmp_path / "cpu.max").write_text("10000 100000\n")
    assert effective_cpu_count(8, tmp_path) == 1


def test_effective_cores_use_affinity_when_process_cpu_count_is_missing(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.delattr(hardware.os, "process_cpu_count", raising=False)
    monkeypatch.setattr(hardware.os, "sched_getaffinity", lambda _pid: {0, 1}, raising=False)
    assert effective_cpu_count(8, tmp_path) == 2


def test_linux_physical_cores_count_distinct_core_ids(tmp_path: Path) -> None:
    info = tmp_path / "cpuinfo"
    info.write_text(
        "processor : 0\nphysical id : 0\ncore id : 0\n\n"
        "processor : 1\nphysical id : 0\ncore id : 0\n\n"
        "processor : 2\nphysical id : 0\ncore id : 1\n\n"
        "processor : 3\nphysical id : 1\ncore id : 0\n"
    )
    assert hardware._linux_physical_cores(info) == 3


def test_nvidia_smi_parses_name_vram_and_driver(monkeypatch) -> None:
    monkeypatch.setattr(hardware.shutil, "which", lambda _name: "/usr/bin/nvidia-smi")

    def run(cmd, **_kw):
        return subprocess.CompletedProcess(cmd, 0, "NVIDIA RTX A4000, 16376, 550.54\n", "")

    assert hardware._nvidia_smi(run) == CudaDevice("NVIDIA RTX A4000", 16376, "550.54")


@pytest.mark.parametrize("failure", [OSError("gone"), subprocess.TimeoutExpired("x", 3)])
def test_nvidia_smi_failures_read_as_no_detail(monkeypatch, failure) -> None:
    monkeypatch.setattr(hardware.shutil, "which", lambda _name: "/usr/bin/nvidia-smi")

    def run(*_a, **_kw):
        raise failure

    assert hardware._nvidia_smi(run) is None


def test_nvidia_smi_missing_binary_is_no_detail(monkeypatch) -> None:
    monkeypatch.setattr(hardware.shutil, "which", lambda _name: None)
    assert hardware._nvidia_smi() is None


def test_probe_reads_the_providers_and_cuda_count(monkeypatch) -> None:
    monkeypatch.setattr(hardware, "_onnx_providers", lambda: (CUDA_PROVIDER, CPU_PROVIDER))
    monkeypatch.setattr(hardware, "_ctranslate2_cuda_devices", lambda: 2)
    monkeypatch.setattr(hardware, "_nvidia_smi", lambda: CudaDevice("Quadro", 8000, "540.1"))
    profile = probe_hardware()
    assert profile.cuda == CudaDevice("Quadro", 8000, "540.1")
    assert profile.ctranslate2_cuda_devices == 2
    assert profile.onnx_provider_order()[0] == CUDA_PROVIDER
    assert 1 <= profile.effective_cores <= profile.logical_cores


def test_cuda_count_without_nvidia_smi_still_reports_a_device(monkeypatch) -> None:
    monkeypatch.setattr(hardware, "_onnx_providers", lambda: (CUDA_PROVIDER, CPU_PROVIDER))
    monkeypatch.setattr(hardware, "_ctranslate2_cuda_devices", lambda: 1)
    monkeypatch.setattr(hardware, "_nvidia_smi", lambda: None)
    assert probe_hardware().cuda == CudaDevice()


def test_a_listed_provider_without_a_device_is_not_a_gpu(monkeypatch) -> None:
    monkeypatch.setattr(hardware, "_onnx_providers", lambda: (CUDA_PROVIDER, CPU_PROVIDER))
    monkeypatch.setattr(hardware, "_ctranslate2_cuda_devices", lambda: 0)
    monkeypatch.setattr(hardware, "_nvidia_smi", lambda: None)
    profile = probe_hardware()
    assert profile.cuda is None
    assert profile.onnx_provider_order() == (CPU_PROVIDER,)
    assert "No GPU found" in profile.summary()


def test_coreml_on_an_intel_mac_is_not_used() -> None:
    intel = _profile(
        system="Darwin", machine="x86_64", onnx_providers=(COREML_PROVIDER, CPU_PROVIDER)
    )
    assert intel.onnx_provider_order() == (CPU_PROVIDER,)


def test_one_failing_part_keeps_the_others(monkeypatch) -> None:
    def broken():
        raise OSError("libcudart.so missing")

    monkeypatch.setattr(hardware, "_onnx_providers", broken)
    monkeypatch.setattr(hardware, "_ctranslate2_cuda_devices", lambda: 0)
    monkeypatch.setattr(hardware, "_nvidia_smi", lambda: None)
    monkeypatch.setattr(hardware, "_ram_bytes", lambda: 123)
    monkeypatch.setattr(hardware, "_physical_cores", lambda: 3)
    profile = probe_hardware()
    assert profile.onnx_providers == (CPU_PROVIDER,)
    assert profile.ram_bytes == 123
    assert profile.physical_cores == 3


def test_a_failing_probe_reads_as_cpu_only_and_never_raises(monkeypatch) -> None:
    def boom():
        raise RuntimeError("driver exploded")

    monkeypatch.setattr(hardware, "_onnx_providers", boom)
    monkeypatch.setattr(hardware, "_ctranslate2_cuda_devices", lambda: 0)
    monkeypatch.setattr(hardware, "_nvidia_smi", lambda: None)
    profile = probe_hardware()
    assert profile.onnx_provider_order() == (CPU_PROVIDER,)
    assert profile.cuda is None
    assert profile.effective_cores >= 1


def test_missing_onnxruntime_is_cpu_only(monkeypatch) -> None:
    import builtins

    real = builtins.__import__

    def deny(name, *args, **kw):
        if name == "onnxruntime":
            raise ImportError(name)
        return real(name, *args, **kw)

    monkeypatch.setattr(builtins, "__import__", deny)
    assert hardware._onnx_providers() == (CPU_PROVIDER,)


def test_the_profile_is_computed_once_and_a_fake_can_replace_it(monkeypatch) -> None:
    calls: list[int] = []
    monkeypatch.setattr(hardware, "probe_hardware", lambda: calls.append(1) or cpu_only_profile(2))
    hardware.reset_hardware_cache()
    try:
        first = hardware_profile()
        assert hardware_profile() is first
        assert calls == [1]
        with use_hardware_profile(NVIDIA):
            assert hardware_profile() is NVIDIA
        assert hardware_profile() is first
    finally:
        hardware.reset_hardware_cache()


def test_doctor_and_support_bundle_report_the_profile_in_plain_words(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from podcast_mcp.services.support import diagnostics
    from podcast_mcp.services.support.doctor import run_doctor_checks

    monkeypatch.delenv("PODCAST_ACCELERATOR", raising=False)
    with use_hardware_profile(APPLE):
        checks = [c.message for c in run_doctor_checks().checks]
        report = diagnostics._build_report_json(
            None, home=tmp_path, workspace=tmp_path, job_snapshots=None
        )
    assert any(m.startswith("hardware: Apple Silicon") for m in checks)
    assert report["hardware"]["onnx_provider_order"] == [COREML_PROVIDER, CPU_PROVIDER]
    assert report["hardware"]["preference"] == "auto"
    monkeypatch.setenv("PODCAST_ACCELERATOR", "cpu")
    with use_hardware_profile(APPLE):
        report = diagnostics._build_report_json(
            None, home=tmp_path, workspace=tmp_path, job_snapshots=None
        )
    assert report["hardware"]["onnx_provider_order"] == [CPU_PROVIDER]
    assert report["hardware"]["preference"] == "cpu"


def test_preference_reads_the_pipeline_defaults_when_none_are_passed(monkeypatch) -> None:
    from podcast_mcp.config import defaults

    monkeypatch.delenv("PODCAST_ACCELERATOR", raising=False)
    monkeypatch.setattr(defaults, "load_defaults", lambda: {"performance": {"accelerator": "cpu"}})
    assert accelerator_preference() == "cpu"


def test_a_gpu_that_onnx_runtime_cannot_use_is_named_in_the_summary() -> None:
    nvidia = _profile(cuda=CudaDevice("RTX 4070", 12000, "550.1"), onnx_providers=(CPU_PROVIDER,))
    assert "NVIDIA GPU found, but ONNX Runtime has no CUDA support" in nvidia.summary()
    apple = _profile(system="Darwin", machine="arm64", apple_silicon=True)
    assert "Apple Silicon found, but ONNX Runtime has no Core ML support" in apple.summary()
