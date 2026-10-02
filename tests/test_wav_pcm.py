from __future__ import annotations

import numpy as np
import pytest

from podcast_mcp.util.wav_pcm import decode_integer_pcm


@pytest.mark.parametrize("width", [1, 2, 3, 4])
@pytest.mark.parametrize("dtype", ["float32", "float64"])
def test_integer_pcm_normalizes_complete_stereo_frames(width: int, dtype: str) -> None:
    scale = 1 << (8 * width - 1)
    values = [0, scale // 2, -scale // 2, scale - 1]
    signed = width != 1
    raw = b"".join(
        (value + (128 if width == 1 else 0)).to_bytes(width, "little", signed=signed)
        for value in values
    )
    result = decode_integer_pcm(raw + b"\xff", width=width, channels=2, dtype=dtype)
    assert result.shape == (2, 2)
    assert result.dtype == np.dtype(dtype)
    expected = np.array([[0.0, 0.5], [-0.5, 1.0 - 1.0 / scale]], dtype=np.float64)
    np.testing.assert_array_equal(result, expected.astype(dtype))


@pytest.mark.parametrize("width,channels", [(0, 1), (5, 1), (2, 0)])
def test_integer_pcm_rejects_invalid_frame_shape(width: int, channels: int) -> None:
    with pytest.raises(ValueError):
        decode_integer_pcm(b"", width=width, channels=channels, dtype="float64")
