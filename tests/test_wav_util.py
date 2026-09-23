from __future__ import annotations

import io
import wave

import pytest

from podcast_mcp.util.wav import MAX_PCM_WAV_DATA_BYTES, WAV_HEADER_BYTES, pcm_wav_header


def test_pcm_wav_header_round_trips_through_wave():
    pcm = b"\x00\x00" * 480
    header = pcm_wav_header(len(pcm), 48_000, channels=1)
    assert len(header) == WAV_HEADER_BYTES
    with wave.open(io.BytesIO(header + pcm)) as audio:
        assert audio.getframerate() == 48_000
        assert audio.getnchannels() == 1
        assert audio.getsampwidth() == 2
        assert audio.getnframes() == 480


@pytest.mark.parametrize("size", [-1, MAX_PCM_WAV_DATA_BYTES + 1])
def test_pcm_wav_header_rejects_sizes_outside_riff_range(size):
    with pytest.raises(ValueError, match="RIFF"):
        pcm_wav_header(size)


def test_pcm_wav_header_accepts_largest_riff_payload():
    assert len(pcm_wav_header(MAX_PCM_WAV_DATA_BYTES)) == WAV_HEADER_BYTES
