"""Canonical 16-bit PCM WAV header (RIFF) shared by record landing and fixtures."""

from __future__ import annotations

import struct

PCM_SAMPLE_WIDTH_BYTES = 2
WAV_HEADER_BYTES = 44
# RIFF sizes are unsigned 32-bit; the RIFF chunk size is ``36 + data_size``.
MAX_PCM_WAV_DATA_BYTES = 0xFFFFFFFF - (WAV_HEADER_BYTES - 8)


def pcm_wav_header(data_size: int, sample_rate: int = 48_000, channels: int = 1) -> bytes:
    """Return the 44-byte header for ``data_size`` bytes of 16-bit PCM."""
    if data_size < 0 or data_size > MAX_PCM_WAV_DATA_BYTES:
        raise ValueError(f"PCM payload of {data_size} bytes does not fit a RIFF WAV header")
    block_align = channels * PCM_SAMPLE_WIDTH_BYTES
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_size,
        b"WAVE",
        b"fmt ",
        16,
        1,
        channels,
        sample_rate,
        sample_rate * block_align,
        block_align,
        PCM_SAMPLE_WIDTH_BYTES * 8,
        b"data",
        data_size,
    )
