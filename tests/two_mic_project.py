"""A two-mic project with known speech, bleed and silence spans (#780 evidence-gate tests)."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np

from podcast_mcp.models import Clip, EpisodeProject, MediaAsset, Track, TrackRole

SR = 8000
# Host's own word: a -30 dBFS tone on the host mic, nothing on the guest mic.
HOST_SPEECH = (0.5, 1.0)
# The guest talking: -12 dBFS on the guest mic, reaching the host mic 20 dB down.
GUEST_SPEECH = (1.5, 2.0)
# Nothing but the noise bed on either mic.
SILENCE = (2.5, 2.6)


def write_wav(path: Path, samples: np.ndarray, sample_rate: int = SR) -> None:
    pcm = np.round(np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sample_rate)
        f.writeframes(pcm.tobytes())


def two_mic_project(
    tmp_workspace: Path, *, host_gain_db: float = 0.0, host_timeline_start: float = 0.0
) -> EpisodeProject:
    """Both mics are 3 s long over a -70 dBFS noise bed and sit at session offset 0 unless
    ``host_timeline_start`` places the host clip late (a wrong ingest offset)."""
    rng = np.random.default_rng(780)
    t = np.arange(3 * SR) / SR
    bed = rng.normal(0.0, 10 ** (-70 / 20), 3 * SR)
    h0, h1 = (int(s * SR) for s in HOST_SPEECH)
    g0, g1 = (int(s * SR) for s in GUEST_SPEECH)
    host = bed.copy()
    host[h0:h1] += 10 ** (-30 / 20) * np.sqrt(2) * np.sin(2 * np.pi * 220 * t[h0:h1])
    host[g0:g1] += 10 ** (-32 / 20) * np.sqrt(2) * np.sin(2 * np.pi * 330 * t[g0:g1])
    guest = bed.copy()
    guest[g0:g1] += 10 ** (-12 / 20) * np.sqrt(2) * np.sin(2 * np.pi * 330 * t[g0:g1])
    raw = tmp_workspace / "raw"
    raw.mkdir(exist_ok=True)
    write_wav(raw / "host.wav", host)
    write_wav(raw / "guest.wav", guest)
    project = EpisodeProject.create("gate", str(tmp_workspace))
    project.tracks = [
        Track(
            id=tid,
            label=tid,
            role=TrackRole.DIALOGUE,
            media=MediaAsset(path=f"raw/{tid}.wav", duration_sec=3.0),
            gain_db=host_gain_db if tid == "host" else 0.0,
        )
        for tid in ("host", "guest")
    ]
    project.clips = [
        Clip(
            id=f"c_{tid}",
            track_id=tid,
            source_start=0.0,
            source_end=3.0,
            timeline_start=host_timeline_start if tid == "host" else 0.0,
        )
        for tid in ("host", "guest")
    ]
    return project
