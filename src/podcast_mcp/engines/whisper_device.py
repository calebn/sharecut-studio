"""Where Whisper runs: an NVIDIA GPU when this machine has a usable one, otherwise the CPU (#2248).

CTranslate2 (behind faster-whisper) supports CUDA but not Metal, so Apple Silicon stays on the
CPU here. The choice never fails a job: ``choose_placement`` returns the CPU for anything unclear
and the engine falls back to the CPU when a GPU load or run fails.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from podcast_mcp.util.hardware import HardwareProfile, accelerator_preference, hardware_profile

CPU_COMPUTE_TYPE = "int8"
_CUDA_COMPUTE_TYPES = ("float16", "int8_float16", "int8")

# Rough GPU memory a model needs at float16, in MiB, with room for the audio being decoded.
_VRAM_MB_BY_SIZE_PREFIX = (
    ("tiny", 1000),
    ("base", 1000),
    ("small", 2000),
    ("distil-small", 2000),
    ("medium", 4000),
    ("distil-medium", 4000),
    ("large-v3-turbo", 3500),
    ("distil-large", 4000),
    ("large", 5500),
)
_UNKNOWN_MODEL_VRAM_MB = 5500


@dataclass(frozen=True)
class WhisperPlacement:
    device: str
    compute_type: str
    reason: str | None = None


CPU_PLACEMENT = WhisperPlacement("cpu", CPU_COMPUTE_TYPE)


def whisper_vram_mb(model_size: str) -> int:
    for prefix, mb in _VRAM_MB_BY_SIZE_PREFIX:
        if model_size.startswith(prefix):
            return mb
    return _UNKNOWN_MODEL_VRAM_MB


def _cuda_compute_types() -> Sequence[str]:
    import ctranslate2

    return tuple(ctranslate2.get_supported_compute_types("cuda"))


def choose_placement(
    model_size: str,
    *,
    profile: HardwareProfile | None = None,
    preference: str | None = None,
    compute_types: Callable[[], Sequence[str]] | None = None,
) -> WhisperPlacement:
    """The device and compute type for this model on this machine.

    ``reason`` says in plain words why a present GPU is not used (None when it is used or when
    there is no GPU to speak of).
    """
    profile = profile or hardware_profile()
    if (preference or accelerator_preference()) == "cpu" or not profile.ctranslate2_cuda_devices:
        return CPU_PLACEMENT
    need = whisper_vram_mb(model_size)
    have = profile.cuda.vram_mb if profile.cuda is not None else None
    if have is not None and have < need:
        return WhisperPlacement(
            "cpu",
            CPU_COMPUTE_TYPE,
            f"the GPU has {have} MB of memory and the {model_size} model needs about {need} MB",
        )
    try:
        supported = set((compute_types or _cuda_compute_types)())
    except Exception as exc:
        return WhisperPlacement("cpu", CPU_COMPUTE_TYPE, f"the GPU could not be queried ({exc})")
    for compute_type in _CUDA_COMPUTE_TYPES:
        if compute_type in supported:
            return WhisperPlacement("cuda", compute_type)
    return WhisperPlacement(
        "cpu", CPU_COMPUTE_TYPE, "the GPU supports none of the needed number formats"
    )
