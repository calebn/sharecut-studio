"""One cached, never-raising answer to "what can this machine run on" (#2247).

``hardware_profile()`` probes once per process: platform, Apple Silicon, an NVIDIA CUDA device,
DirectML, the ONNX Runtime execution providers, CTranslate2's CUDA device count, physical and
logical cores, the cores this process may actually use (affinity and cgroup quota) and total
RAM. The probe loads no model and allocates no GPU memory, and any failure of one part leaves
that part at its CPU-only value. Nothing here chooses a device for a model; later children of
#2246 read the profile and ``onnx_provider_order`` to do that.

The preference is ``auto`` or ``cpu``. ``PODCAST_ACCELERATOR`` (support override) wins over
``performance.accelerator`` in the pipeline defaults.
"""

from __future__ import annotations

import ctypes
import logging
import math
import os
import platform
import re
import shutil
import subprocess  # nosec B404
import sys
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, TypeVar

from podcast_mcp import settings

log = logging.getLogger(__name__)

_T = TypeVar("_T")

ACCELERATORS = ("auto", "cpu")

CUDA_PROVIDER = "CUDAExecutionProvider"
COREML_PROVIDER = "CoreMLExecutionProvider"
DIRECTML_PROVIDER = "DmlExecutionProvider"
CPU_PROVIDER = "CPUExecutionProvider"
PROVIDER_PRIORITY = (CUDA_PROVIDER, COREML_PROVIDER, DIRECTML_PROVIDER, CPU_PROVIDER)

_CGROUP_ROOT = Path("/sys/fs/cgroup")
_MEMINFO = Path("/proc/meminfo")
_PROBE_TIMEOUT_SEC = 3.0


@dataclass(frozen=True)
class CudaDevice:
    name: str | None = None
    vram_mb: int | None = None
    driver: str | None = None


@dataclass(frozen=True)
class HardwareProfile:
    system: str
    machine: str
    apple_silicon: bool
    cuda: CudaDevice | None
    directml: bool
    onnx_providers: tuple[str, ...]
    ctranslate2_cuda_devices: int
    physical_cores: int | None
    logical_cores: int
    effective_cores: int
    ram_bytes: int | None

    def onnx_provider_order(self, preference: str = "auto") -> tuple[str, ...]:
        """The execution providers to ask ONNX Runtime for, best first, always ending in CPU."""
        if preference == "cpu":
            return (CPU_PROVIDER,)
        have = set(self.onnx_providers)
        usable = {
            CUDA_PROVIDER: self.cuda is not None,
            COREML_PROVIDER: self.apple_silicon,
            DIRECTML_PROVIDER: self.directml,
        }
        ranked = tuple(p for p in PROVIDER_PRIORITY if p in have and usable.get(p, False))
        return (*ranked, CPU_PROVIDER)

    def summary(self, preference: str = "auto") -> str:
        """Plain words for the doctor and the support bundle."""
        cores = f"{self.effective_cores} usable CPU core{'s' if self.effective_cores != 1 else ''}"
        if self.effective_cores < self.logical_cores:
            cores += f" of {self.logical_cores}"
        if preference == "cpu":
            return f"Accelerator turned off (cpu): everything runs on the CPU, {cores}."
        best = self.onnx_provider_order("auto")[0]
        nvidia = "NVIDIA GPU"
        if self.cuda is not None and self.cuda.name:
            nvidia += f" ({self.cuda.name})"
        if self.ctranslate2_cuda_devices:
            return f"{nvidia} detected; speech-to-text uses it when the model fits, the other steps run on the CPU, {cores}."
        if best == CUDA_PROVIDER:
            return f"{nvidia} detected; no model uses it yet, {cores}."
        if best == COREML_PROVIDER:
            return f"Apple Silicon GPU and Neural Engine (Core ML) detected; no model uses it yet, {cores}."
        if best == DIRECTML_PROVIDER:
            return f"Windows GPU (DirectML) detected; no model uses it yet, {cores}."
        if self.cuda is not None:
            return f"NVIDIA GPU found, but ONNX Runtime has no CUDA support here: everything runs on the CPU, {cores}."
        if self.apple_silicon:
            return f"Apple Silicon found, but ONNX Runtime has no Core ML support here: everything runs on the CPU, {cores}."
        return f"No GPU found: everything runs on the CPU, {cores}."

    def to_dict(self, preference: str = "auto") -> dict[str, Any]:
        out = asdict(self)
        out["preference"] = preference
        out["onnx_provider_order"] = list(self.onnx_provider_order(preference))
        out["summary"] = self.summary(preference)
        return out


def cpu_only_profile(logical_cores: int | None = None) -> HardwareProfile:
    """A machine with no accelerator; the base the tests build their fake machines on."""
    logical = max(1, logical_cores or os.cpu_count() or 1)
    return HardwareProfile(
        system=platform.system(),
        machine=platform.machine(),
        apple_silicon=False,
        cuda=None,
        directml=False,
        onnx_providers=(CPU_PROVIDER,),
        ctranslate2_cuda_devices=0,
        physical_cores=None,
        logical_cores=logical,
        effective_cores=logical,
        ram_bytes=None,
    )


def _pipeline_defaults() -> Mapping[str, Any]:
    from podcast_mcp.config.defaults import load_defaults

    return _part(load_defaults, {})


def accelerator_preference(defaults: Mapping[str, Any] | None = None) -> str:
    """``auto`` or ``cpu``: the env override, else ``performance.accelerator``, else ``auto``."""
    env = settings.text("PODCAST_ACCELERATOR").lower()
    if env in ACCELERATORS:
        return env
    if defaults is None:
        defaults = _pipeline_defaults()
    performance = defaults.get("performance")
    configured = performance.get("accelerator") if isinstance(performance, Mapping) else None
    return configured if configured in ACCELERATORS else "auto"


def cgroup_cpu_limit(root: Path = _CGROUP_ROOT) -> float | None:
    """The CPU quota of this container in cores, or None when unlimited or unknown."""
    try:
        text = (root / "cpu.max").read_text().split()
        if len(text) == 2 and text[0] != "max":
            return int(text[0]) / int(text[1])
    except (OSError, ValueError, ZeroDivisionError):
        pass
    try:
        quota = int((root / "cpu" / "cpu.cfs_quota_us").read_text())
        period = int((root / "cpu" / "cpu.cfs_period_us").read_text())
        if quota > 0 and period > 0:
            return quota / period
    except (OSError, ValueError):
        pass
    return None


def effective_cpu_count(logical: int, cgroup_root: Path = _CGROUP_ROOT) -> int:
    """Cores this process may use: the smallest of logical, affinity and the cgroup quota."""
    counts = [logical]
    process_cpu_count = getattr(os, "process_cpu_count", None)
    try:
        if process_cpu_count is not None:
            allowed = process_cpu_count()
            if allowed:
                counts.append(allowed)
        elif hasattr(os, "sched_getaffinity"):
            counts.append(len(os.sched_getaffinity(0)))
    except OSError:
        pass
    quota = cgroup_cpu_limit(cgroup_root)
    if quota is not None:
        counts.append(max(1, math.ceil(quota)))
    return max(1, min(counts))


def _linux_physical_cores(cpuinfo: Path = Path("/proc/cpuinfo")) -> int | None:
    pairs: set[tuple[str, str]] = set()
    package = ""
    for line in cpuinfo.read_text().splitlines():
        key, _, value = line.partition(":")
        key, value = key.strip(), value.strip()
        if key == "physical id":
            package = value
        elif key == "core id":
            pairs.add((package, value))
    return len(pairs) or None


def _physical_cores() -> int | None:
    system = platform.system()
    try:
        if system == "Linux":
            return _linux_physical_cores()
        if system == "Darwin":
            out = subprocess.run(  # nosec B603 B607
                ["sysctl", "-n", "hw.physicalcpu"],
                capture_output=True,
                text=True,
                timeout=_PROBE_TIMEOUT_SEC,
                check=True,
            ).stdout
            return int(out.strip()) or None
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def _ram_bytes_win32(field: str) -> int | None:
    class _MemoryStatus(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    status = _MemoryStatus()
    status.dwLength = ctypes.sizeof(_MemoryStatus)
    if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):  # type: ignore[attr-defined]
        return int(getattr(status, field))
    return None


def _ram_bytes() -> int | None:
    try:
        if sys.platform == "win32":
            return _ram_bytes_win32("ullTotalPhys")
        return int(os.sysconf("SC_PAGE_SIZE")) * int(os.sysconf("SC_PHYS_PAGES"))
    except (OSError, ValueError, AttributeError):
        return None


def available_ram_bytes() -> int | None:
    """RAM that can be handed out now without swapping, or None when the platform will not say."""
    try:
        if sys.platform == "win32":
            return _ram_bytes_win32("ullAvailPhys")
        if sys.platform == "darwin":
            out = subprocess.run(  # nosec B603 B607
                ["vm_stat"], capture_output=True, text=True, timeout=_PROBE_TIMEOUT_SEC, check=True
            ).stdout
            page = int(re.search(r"page size of (\d+) bytes", out).group(1))  # type: ignore[union-attr]
            pages = sum(
                int(m.group(1))
                for m in re.finditer(r"Pages (?:free|inactive|speculative):\s+(\d+)", out)
            )
            return pages * page
        for line in _MEMINFO.read_text(encoding="ascii").splitlines():
            if line.startswith("MemAvailable:"):
                host = int(line.split()[1]) * 1024
                room = _cgroup_headroom_bytes()
                return host if room is None else min(host, room)
    except (OSError, ValueError, AttributeError, subprocess.SubprocessError):
        pass
    return None


_NO_LIMIT_BYTES = 1 << 60  # cgroup v1 reports an unlimited limit as a near-2^63 page-rounded number


def _read_cgroup_int(path: Path) -> int | None:
    """The file's integer, or None when missing, unreadable or "max" (no limit)."""
    try:
        text = path.read_text(encoding="ascii").strip()
        return None if text == "max" else int(text)
    except (OSError, ValueError):
        return None


def _cgroup_headroom_bytes(root: Path | None = None) -> int | None:
    """Bytes left under this container's memory limit (cgroup v2, else v1); None when unlimited."""
    root = _CGROUP_ROOT if root is None else root
    for limit_file, used_file in (
        (root / "memory.max", root / "memory.current"),
        (root / "memory" / "memory.limit_in_bytes", root / "memory" / "memory.usage_in_bytes"),
    ):
        limit = _read_cgroup_int(limit_file)
        used = _read_cgroup_int(used_file)
        if limit is None or used is None or limit >= _NO_LIMIT_BYTES:
            continue
        return max(0, limit - used)
    return None


def _onnx_providers() -> tuple[str, ...]:
    try:
        import onnxruntime
    except ImportError:
        return (CPU_PROVIDER,)
    return tuple(onnxruntime.get_available_providers())


def _ctranslate2_cuda_devices() -> int:
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count())
    except Exception:
        return 0


def _nvidia_smi(
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> CudaDevice | None:
    exe = shutil.which("nvidia-smi")
    if exe is None:
        return None
    try:
        out = run(
            [exe, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=_PROBE_TIMEOUT_SEC,
            check=True,
        ).stdout
        name, vram, driver = (part.strip() for part in out.splitlines()[0].split(","))
        return CudaDevice(name=name or None, vram_mb=int(float(vram)), driver=driver or None)
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


def _part(read: Callable[[], _T], fallback: _T) -> _T:
    try:
        return read()
    except Exception:
        log.warning(
            "hardware probe: %s failed; using %r", getattr(read, "__name__", "part"), fallback
        )
        return fallback


def probe_hardware() -> HardwareProfile:
    """Probe this machine now. Never raises; each part that fails reports its CPU-only value."""
    logical = max(1, os.cpu_count() or 1)
    providers: tuple[str, ...] = _part(_onnx_providers, (CPU_PROVIDER,))
    cuda_devices = _part(_ctranslate2_cuda_devices, 0)
    cuda = _part(_nvidia_smi, None)
    if cuda is None and cuda_devices > 0:
        cuda = CudaDevice()
    system = _part(platform.system, "")
    machine = _part(platform.machine, "")
    return HardwareProfile(
        system=system,
        machine=machine,
        apple_silicon=system == "Darwin" and machine == "arm64",
        cuda=cuda,
        directml=DIRECTML_PROVIDER in providers,
        onnx_providers=providers,
        ctranslate2_cuda_devices=cuda_devices,
        physical_cores=_part(_physical_cores, None),
        logical_cores=logical,
        effective_cores=_part(lambda: effective_cpu_count(logical), logical),
        ram_bytes=_part(_ram_bytes, None),
    )


_override: HardwareProfile | None = None


@lru_cache(maxsize=1)
def _probed() -> HardwareProfile:
    return probe_hardware()


def hardware_profile() -> HardwareProfile:
    """The cached profile of this machine (or the one a test injected)."""
    return _override if _override is not None else _probed()


def cpu_budget() -> int:
    """The cores this process may use (affinity and container quota respected), at least 1.

    The one place thread and worker counts start from; ``os.cpu_count()`` ignores both limits.
    It reads only the core count, affinity and quota, so the first call does not pay for the GPU
    probe.
    """
    if _override is not None:
        return max(1, _override.effective_cores)
    return effective_cpu_count(max(1, os.cpu_count() or 1))


def reset_hardware_cache() -> None:
    _probed.cache_clear()


@contextmanager
def use_hardware_profile(profile: HardwareProfile) -> Iterator[HardwareProfile]:
    """Make ``hardware_profile()`` return ``profile`` inside the block (tests and fakes)."""
    global _override
    previous = _override
    _override = profile
    try:
        yield profile
    finally:
        _override = previous
