"""Mono downmix policy for level reads and whole-file decode.

Integer WAV windows use :func:`read_open_wav_mono_window`, which averages channels.
ffmpeg's ``-ac 1`` uses its default stereo matrix (each input at about -3 dB), so
identical dual-mono reads about +3.01 dB hotter than the wave path. Level profiles
and bounded windows must share one rule: the per-channel mean.
"""

from __future__ import annotations

import wave
from pathlib import Path


def channel_mean_pan_filter(channels: int) -> str:
    if channels < 1:
        raise ValueError("channels must be >= 1")
    if channels == 1:
        return "pan=mono|c0=c0"
    weight = 1.0 / channels
    terms = "+".join(f"{weight:.12g}*c{i}" for i in range(channels))
    return f"pan=mono|c0={terms}"


def _input_channels(path: Path) -> int:
    # media_probe → ffmpeg imports this module; keep the probe import local.
    from podcast_mcp.engines.media_probe import probe_media

    probe = probe_media(path)
    if probe is not None:
        return max(1, int(probe.channels))
    if path.suffix.lower() == ".wav":
        try:
            with wave.open(str(path), "rb") as wf:
                return max(1, int(wf.getnchannels() or 1))
        except (OSError, wave.Error):
            pass
    return 1


def ffmpeg_mono_mean_layout(path: Path) -> list[str]:
    channels = _input_channels(path)
    if channels == 1:
        return ["-ac", "1"]
    return ["-af", channel_mean_pan_filter(channels)]
