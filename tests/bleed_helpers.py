"""Synthetic three-mic recordings with bleed and recorder latency (#1037, #1071)."""

from __future__ import annotations

import wave
from collections.abc import Callable
from pathlib import Path

import numpy as np

from podcast_mcp.edits.bleed_latency import FRAME_SEC, HOP_SEC
from podcast_mcp.engines.envelope_lag import LEVEL_FLOOR_DB, level_envelope_db
from podcast_mcp.models import Clip, MediaAsset, Track, TrackRole
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.dsp import frame_peak_db

RATE = 8000
DURATION_SEC = 240.0
SPEAKERS = ("caleb", "audra", "lana")


def voices(seed: int = 7) -> dict[str, np.ndarray]:
    """Speech-like bursts: syllables of shaped noise inside non-overlapping turns."""
    rng = np.random.default_rng(seed)
    total = round(DURATION_SEC * RATE)
    out = {name: np.zeros(total) for name in SPEAKERS}
    t = 1.0
    while t < DURATION_SEC - 6.0:
        name = SPEAKERS[int(rng.integers(len(SPEAKERS)))]
        end = t + rng.uniform(2.0, 5.0)
        while t < end:
            size = round(rng.uniform(0.08, 0.25) * RATE)
            first = round(t * RATE)
            out[name][first : first + size] += (
                rng.standard_normal(size) * np.hanning(size) * rng.uniform(0.1, 0.3)
            )
            t += size / RATE + rng.uniform(0.03, 0.2)
        t += rng.uniform(0.2, 0.8)
    return out


def delay(samples: np.ndarray, sec: float) -> np.ndarray:
    count = round(sec * RATE)
    return np.concatenate([np.zeros(count), samples[: samples.size - count]])


def tracks(
    *,
    bleed: dict[str, dict[str, float]],
    latency: dict[str, float] | None = None,
    gated: tuple[str, ...] = (),
    seed: int = 7,
) -> dict[str, np.ndarray]:
    """``bleed[mic][voice] = copy delay`` (sec); ``latency`` delays a whole track."""
    dry = voices(seed)
    rng = np.random.default_rng(seed + 4)
    out: dict[str, np.ndarray] = {}
    for mic in SPEAKERS:
        signal = dry[mic].copy()
        for voice, copy_delay in bleed.get(mic, {}).items():
            signal += 0.1 * delay(dry[voice], copy_delay)
        if mic in gated:
            signal[np.abs(dry[mic]) == 0] = 0.0
        else:
            signal += 1e-4 * rng.standard_normal(signal.size)
        out[mic] = delay(signal, (latency or {}).get(mic, 0.0))
    return out


def levels(audio: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    return {
        name: level_envelope_db(samples, sample_rate=RATE, frame_sec=FRAME_SEC, hop_sec=HOP_SEC)
        for name, samples in audio.items()
    }


def peaks(audio: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """Each frame's sample peak (dB) on the :func:`levels` grid."""
    frame, hop = round(FRAME_SEC * RATE), round(HOP_SEC * RATE)
    return {
        name: np.maximum(frame_peak_db(samples, frame, hop), LEVEL_FLOOR_DB)
        for name, samples in audio.items()
    }


def write_wav(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(samples * 32767, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(pcm.tobytes())


def workspace(tmp_path: Path, audio: dict[str, np.ndarray]) -> ProjectWorkspace:
    ws = ProjectWorkspace.create(tmp_path / "ep")
    project = ws.project
    for name in SPEAKERS:
        write_wav(Path(project.meta.workspace_dir) / "raw" / f"{name}.wav", audio[name])
        project.tracks.append(
            Track(
                id=name,
                label=name.title(),
                role=TrackRole.DIALOGUE,
                speaker=name.title(),
                media=MediaAsset(path=f"raw/{name}.wav", duration_sec=DURATION_SEC),
            )
        )
        project.clips.append(
            Clip(
                id=f"clip_{name}",
                track_id=name,
                source_start=0.0,
                source_end=DURATION_SEC,
                timeline_start=0.0,
            )
        )
    ws.save()
    return ws


def geometry(ws: ProjectWorkspace, track_id: str) -> tuple[float, float, float]:
    clip = next(c for c in ws.project.clips if c.track_id == track_id)
    return round(clip.source_start, 3), round(clip.source_end, 3), round(clip.timeline_start, 3)


def spurts(direct: np.ndarray, *, gap_sec: float = 0.2) -> list[tuple[int, int]]:
    """Sample ranges of a gated track's talk spurts (split by silences of ``gap_sec``)."""
    voiced = np.flatnonzero(direct != 0)
    breaks = np.flatnonzero(np.diff(voiced) > gap_sec * RATE)
    firsts = np.concatenate([voiced[:1], voiced[breaks + 1]])
    lasts = np.concatenate([voiced[breaks], voiced[-1:]]) + 1
    return list(zip(firsts.tolist(), lasts.tolist(), strict=True))


def relatency(direct: np.ndarray, latency: Callable[[float], float]) -> np.ndarray:
    """Delay each talk spurt of a gated track by ``latency(spurt start in seconds)``."""
    out = np.zeros_like(direct)
    for first, last in spurts(direct):
        shift = round(latency(first / RATE) * RATE)
        end = min(last + shift, out.size)
        out[first + shift : end] += direct[first : end - shift]
    return out
