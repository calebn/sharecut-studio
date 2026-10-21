"""SpeechBrain ECAPA front end in numpy: log-mel filterbank plus sentence mean norm.

The ONNX export of ``speechbrain/spkrec-ecapa-voxceleb`` covers the embedding
network only (torch's STFT does not export), so the features it consumes are
rebuilt here to match ``Fbank(n_mels=80)`` followed by the ``sentence``
``InputNormalization`` from that model's ``hyperparams.yaml``. ``tests`` pin the
output against the torch pipeline when SpeechBrain is installed.
"""

from __future__ import annotations

import math

import numpy as np

SAMPLE_RATE = 16000
N_MELS = 80
N_FFT = 400
WIN_LENGTH = 400  # 25 ms at 16 kHz
HOP_LENGTH = 160  # 10 ms at 16 kHz
_AMIN = 1e-10
_TOP_DB = 80.0


def _to_mel(hz: float) -> float:
    return 2595.0 * math.log10(1.0 + hz / 700.0)


def _to_hz(mel: np.ndarray) -> np.ndarray:
    return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)


def _filterbank() -> np.ndarray:
    """Triangular mel filters as SpeechBrain builds them, shape (n_fft // 2 + 1, n_mels)."""
    mel = np.linspace(_to_mel(0.0), _to_mel(SAMPLE_RATE // 2), N_MELS + 2, dtype=np.float32)
    hz = _to_hz(mel).astype(np.float32)
    band = (hz[1:] - hz[:-1])[:-1]
    centre = hz[1:-1]
    freqs = np.linspace(0, SAMPLE_RATE // 2, N_FFT // 2 + 1, dtype=np.float32)
    slope = (freqs[None, :] - centre[:, None]) / band[:, None]
    return np.maximum(0.0, np.minimum(slope + 1.0, -slope + 1.0)).T.astype(np.float32)


_FILTERBANK = _filterbank()
# torch.hamming_window(400) is the periodic window
_WINDOW = (0.54 - 0.46 * np.cos(2.0 * np.pi * np.arange(WIN_LENGTH) / WIN_LENGTH)).astype(
    np.float32
)


def ecapa_features(samples: np.ndarray) -> np.ndarray:
    """(frames, 80) float32 features for mono 16 kHz ``samples``, ready for the ONNX model."""
    x = np.asarray(samples, dtype=np.float32).reshape(-1)
    padded = np.pad(x, (N_FFT // 2, N_FFT // 2))  # center=True, constant (zero) padding
    frames = 1 + x.size // HOP_LENGTH
    index = np.arange(N_FFT)[None, :] + HOP_LENGTH * np.arange(frames)[:, None]
    spectrum = np.fft.rfft(padded[index] * _WINDOW, axis=1)
    power = (spectrum.real**2 + spectrum.imag**2).astype(np.float32)
    mel = 10.0 * np.log10(np.maximum(power @ _FILTERBANK, _AMIN))
    mel = np.maximum(mel, mel.max() - _TOP_DB)
    return (mel - mel.mean(axis=0, keepdims=True)).astype(np.float32)
