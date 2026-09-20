"""Silero VAD speech-probability wrapper, reused from faster-whisper's bundled model.

`faster-whisper` already ships a Silero VAD ONNX model (`silero_vad_v6.onnx`) and
depends unconditionally on `onnxruntime` to run it (for its own `vad_filter`
transcription option). Since faster-whisper is a core, non-optional dependency
of this project, Silero VAD is effectively free here: no extra download, no
extra optional dependency, no bootstrap step required.

This module is a thin adapter exposing a per-window speech-probability API on
top of `faster_whisper.vad.SileroVADModel`, for callers (breath detection)
that want a probability curve rather than faster-whisper's speech-segment
timestamps. It deliberately reuses faster-whisper's model-loading and ONNX
I/O plumbing rather than re-deriving the (undocumented, version-specific)
input/state contract of the bundled model.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import numpy as np


def model_path() -> Path:
    """Path to the Silero VAD ONNX model bundled inside faster-whisper."""
    from faster_whisper.utils import get_assets_path

    path = Path(get_assets_path()) / "silero_vad_v6.onnx"
    if not path.is_file():
        raise FileNotFoundError(f"Silero VAD model not found at {path}")
    return path


def is_available() -> bool:
    """Whether Silero VAD can be used (onnxruntime + bundled model present)."""
    import importlib.util

    if importlib.util.find_spec("onnxruntime") is None:
        return False
    try:
        model_path()
    except Exception:
        return False
    return True


class SileroVAD:
    """Per-window speech-probability inference over the bundled Silero VAD model."""

    SAMPLE_RATE = 16000
    WINDOW_SAMPLES = 512
    CONTEXT_SAMPLES = 64

    def __init__(self, model_path_override: Path | None = None) -> None:
        from faster_whisper.vad import SileroVADModel

        self._model = SileroVADModel(str(model_path_override or model_path()))

    def speech_probs(self, samples: np.ndarray) -> np.ndarray:
        """Per-window (32ms @16kHz) speech probability for mono float32 samples."""
        if samples.size == 0:
            return np.zeros(0, dtype=np.float32)
        pad = (-samples.size) % self.WINDOW_SAMPLES
        if pad:
            samples = np.pad(samples, (0, pad))
        out = self._model(
            samples.astype(np.float32),
            num_samples=self.WINDOW_SAMPLES,
            context_size_samples=self.CONTEXT_SAMPLES,
        )
        return np.asarray(out).reshape(-1).astype(np.float32)


@lru_cache(maxsize=1)
def _cached_vad() -> SileroVAD | None:
    """Process-wide singleton, shared across parallel analysis threads.

    `onnxruntime.InferenceSession.run` is safe to call concurrently from
    multiple threads on a single session, so one cached instance is enough.
    """
    if not is_available():
        return None
    try:
        return SileroVAD()
    except Exception:
        return None


def get_shared_vad() -> SileroVAD | None:
    """Shared `SileroVAD` instance, or None if unavailable (caller should fall back)."""
    return _cached_vad()
