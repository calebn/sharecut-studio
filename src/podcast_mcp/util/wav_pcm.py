from __future__ import annotations

from typing import Literal

import numpy as np
from numpy.typing import NDArray


def decode_integer_pcm(
    raw: bytes | bytearray,
    *,
    width: int,
    channels: int,
    dtype: Literal["float32", "float64"],
) -> NDArray[np.float32] | NDArray[np.float64]:
    """Return complete `(frames, channels)` samples normalized by integer full scale."""
    if width not in (1, 2, 3, 4) or channels < 1:
        raise ValueError("PCM width must be 1..4 bytes and channels must be positive")
    if dtype not in ("float32", "float64"):
        raise ValueError("dtype must be float32 or float64")
    frame_bytes = width * channels
    usable = len(raw) - len(raw) % frame_bytes
    data = memoryview(raw)[:usable]
    if width == 1:
        values = np.frombuffer(data, dtype=np.uint8).astype(np.float64) - 128.0
    elif width == 3:
        octets = np.frombuffer(data, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        packed = octets[:, 0] | (octets[:, 1] << 8) | (octets[:, 2] << 16)
        values = ((packed ^ 0x800000) - 0x800000).astype(np.float64)
    else:
        values = np.frombuffer(data, dtype=f"<i{width}").astype(np.float64)
    normalized = (values / float(1 << (8 * width - 1))).reshape(-1, channels)
    if dtype == "float32":
        return normalized.astype(np.float32)
    return normalized
