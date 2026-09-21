"""Bounded, local-only detection of voiced audio inside ASR gaps.

This is deliberately a *candidate* detector.  It does not infer a word and its
results always require review; ASR-free VAD commonly labels breaths and noise.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from podcast_mcp.edits.audio_cache import TrackAudioCache


@dataclass(frozen=True)
class AcousticGapRun:
    start: float
    end: float
    confidence: float


def _rms_db(x: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean(np.square(x, dtype=np.float64)))) if x.size else 0.0
    return 20.0 * math.log10(max(rms, 1e-10))


def _voiced(frame: np.ndarray, sample_rate: int) -> bool:
    """Conservative periodicity check (speech F0 approximately 70--350 Hz)."""
    if frame.size < sample_rate // 100:
        return False
    x = frame.astype(np.float64, copy=True)
    x -= np.mean(x)
    norm = float(np.dot(x, x))
    if norm <= 1e-12:
        return False
    lo = max(1, int(sample_rate / 350.0))
    hi = min(frame.size - 1, int(sample_rate / 70.0))
    if hi <= lo:
        return False
    corr = np.correlate(x, x, mode="full")[frame.size - 1 :]
    peak = float(np.max(corr[lo : hi + 1])) / norm
    return peak >= 0.28


def find_voiced_gap_runs(
    cache: TrackAudioCache,
    gap_start: float,
    gap_end: float,
    *,
    min_gap_sec: float = 0.35,
    min_run_sec: float = 0.10,
    max_run_sec: float = 1.5,
    max_frames: int = 600,
) -> list[AcousticGapRun]:
    """Find short voiced runs wholly inside one inter-word gap.

    The scan is capped by ``max_frames`` and never reads beyond the cache's
    decoded source span.  A relative energy floor plus periodicity confirmation
    rejects most room noise, breaths, and digital silence.
    """
    if gap_end - gap_start < min_gap_sec or gap_end <= gap_start:
        return []
    sr = int(cache.waveform.sample_rate)
    frame = max(1, round(sr * 0.025))
    hop = max(1, round(sr * 0.010))
    max_span = (max_frames - 1) * hop / sr + frame / sr
    if gap_end - gap_start > max_span:
        return []
    samples = cache.window(gap_start, min(gap_end, gap_start + max_span))
    if samples.size < frame:
        return []
    n_frames = min(max_frames, 1 + (samples.size - frame) // hop)
    levels = np.asarray([_rms_db(samples[i * hop : i * hop + frame]) for i in range(n_frames)])
    # Keep a few dB of headroom below the loudest frame so a sustained voiced
    # run (a common synthetic/real filler shape) is not rejected as a plateau.
    floor = max(-55.0, min(float(np.percentile(levels, 35)) + 8.0, float(np.max(levels)) - 3.0))
    active = levels >= floor
    # Bridge only very short dips; do not turn two unrelated noises into one hit.
    bridge = max(1, round(0.06 / 0.010))
    for i in range(1, n_frames - 1):
        if (
            not active[i]
            and active[max(0, i - bridge) : i].any()
            and active[i + 1 : i + 1 + bridge].any()
        ):
            active[i] = True
    runs: list[AcousticGapRun] = []
    i = 0
    while i < n_frames:
        if not active[i]:
            i += 1
            continue
        j = i + 1
        while j < n_frames and active[j]:
            j += 1
        start = gap_start + i * hop / sr
        end = min(gap_end, gap_start + (j * hop + frame) / sr)
        dur = end - start
        if min_run_sec <= dur <= max_run_sec:
            mid = samples[max(0, (i * hop + (j - i) * hop // 2) - frame // 2) :][:frame]
            voiced_checks = [
                _voiced(samples[max(0, k * hop - frame // 2) :][:frame], sr)
                for k in range(
                    i,
                    min(j, i + max(1, round(0.12 * sr / hop) * 3)),
                    max(1, round(0.12 * sr / hop)),
                )
            ]
            if _voiced(mid, sr) and sum(voiced_checks) >= max(1, len(voiced_checks) - 1):
                runs.append(
                    AcousticGapRun(
                        start=start,
                        end=end,
                        confidence=min(
                            0.99, max(0.2, (float(np.mean(levels[i:j])) - floor) / 24.0)
                        ),
                    )
                )
        i = j
    return runs
