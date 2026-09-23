"""Bounded, local-only detection of voiced audio inside ASR gaps.

This is deliberately a *candidate* detector.  It does not infer a word and its
results always require review; ASR-free VAD commonly labels breaths and noise.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from podcast_mcp.config import bounded_float
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.util.dsp import autocorr_peak, bool_runs, bridge_short_dips, frame_rms_db

# Hard limits on YAML overrides.  ``min_gap_sec`` may only be raised (shorter
# gaps are inter-word articulation, not a hidden filler); ``max_run_sec`` and
# ``max_frames`` may only be lowered (they bound per-gap DSP cost and the size
# of an unheard cut).
MIN_GAP_SEC_FLOOR = 0.35
MAX_GAP_SEC_CEIL = 10.0
MAX_RUN_SEC_CEIL = 1.5
MIN_RUN_SEC_FLOOR = 0.1
MAX_FRAMES_CEIL = 600
MIN_FRAMES_FLOOR = 20

_FRAME_SEC = 0.025
_HOP_SEC = 0.010
_VOICING_SEC = 0.040
_BRIDGE_SEC = 0.06
# Noise estimate: a low percentile of the gap's frame levels.
_NOISE_PERCENTILE = 20.0
# The loudest frame must stand this far above the gap's noise estimate; a flat
# level (hum, HVAC, steady bleed) never yields a candidate.
_MIN_CONTRAST_DB = 12.0
# Active frames must clear the noise estimate by this margin.
_ACTIVE_MARGIN_DB = 8.0
_ABS_FLOOR_DB = -55.0
# A run filling most of the gap is a level plateau, not a hidden filler.
_MAX_GAP_COVERAGE = 0.8
# Speech F0 search range and normalized autocorrelation threshold.
_F0_MIN_HZ = 70.0
_F0_MAX_HZ = 350.0
_VOICED_PEAK = 0.28


@dataclass(frozen=True)
class AcousticGapConfig:
    """``tighten.acoustic_gap_filler`` settings, clamped to the limits above."""

    enabled: bool = True
    min_gap_sec: float = MIN_GAP_SEC_FLOOR
    max_run_sec: float = MAX_RUN_SEC_CEIL
    max_frames: int = MAX_FRAMES_CEIL

    @classmethod
    def from_tighten(cls, tighten: dict[str, Any] | None) -> AcousticGapConfig:
        raw = (tighten or {}).get("acoustic_gap_filler") or {}
        base = cls()
        return cls(
            enabled=bool(raw.get("enabled", base.enabled)),
            min_gap_sec=bounded_float(
                raw.get("min_gap_sec", base.min_gap_sec),
                base.min_gap_sec,
                MIN_GAP_SEC_FLOOR,
                MAX_GAP_SEC_CEIL,
            ),
            max_run_sec=bounded_float(
                raw.get("max_run_sec", base.max_run_sec),
                base.max_run_sec,
                MIN_RUN_SEC_FLOOR,
                MAX_RUN_SEC_CEIL,
            ),
            max_frames=int(
                bounded_float(
                    raw.get("max_frames", base.max_frames),
                    base.max_frames,
                    MIN_FRAMES_FLOOR,
                    MAX_FRAMES_CEIL,
                )
            ),
        )


@dataclass(frozen=True)
class AcousticGapRun:
    start: float
    end: float
    confidence: float


def _voiced(frame: np.ndarray, sample_rate: int) -> bool:
    """Conservative periodicity check over the speech F0 range."""
    if frame.size < sample_rate // 100:
        return False
    peak = autocorr_peak(frame, sample_rate, fmin=_F0_MIN_HZ, fmax=_F0_MAX_HZ)
    return peak is not None and peak[1] >= _VOICED_PEAK


def _run_is_voiced(samples: np.ndarray, sample_rate: int, i: int, j: int, hop: int) -> bool:
    """Voicing at the run midpoint plus most of a few evenly spaced probes."""
    window = max(1, round(sample_rate * _VOICING_SEC))

    def at(frame_index: int) -> np.ndarray:
        begin = max(0, frame_index * hop - window // 2)
        return samples[begin : begin + window]

    stride = max(1, round(0.12 * sample_rate / hop))
    probes = [_voiced(at(k), sample_rate) for k in range(i, min(j, i + stride * 3), stride)]
    return _voiced(at((i + j) // 2), sample_rate) and sum(probes) >= max(1, len(probes) - 1)


def find_voiced_gap_runs(
    cache: TrackAudioCache,
    gap_start: float,
    gap_end: float,
    *,
    min_gap_sec: float = MIN_GAP_SEC_FLOOR,
    min_run_sec: float = MIN_RUN_SEC_FLOOR,
    max_run_sec: float = MAX_RUN_SEC_CEIL,
    max_frames: int = MAX_FRAMES_CEIL,
) -> list[AcousticGapRun]:
    """Find short voiced runs wholly inside one inter-word gap.

    The scan is capped by ``max_frames`` and never reads beyond the cache's
    decoded source span.  A gap whose level is flat (hum, HVAC, steady bleed)
    is rejected by the contrast check; active frames must clear a low-percentile
    noise estimate, runs covering most of the gap are rejected as plateaus, and
    each run must pass a speech-pitch periodicity check (rejecting white noise
    and most breaths).
    """
    gap = gap_end - gap_start
    if gap < min_gap_sec or gap <= 0:
        return []
    sr = int(cache.waveform.sample_rate)
    frame = max(1, round(sr * _FRAME_SEC))
    hop = max(1, round(sr * _HOP_SEC))
    max_span = (max_frames - 1) * hop / sr + frame / sr
    if gap > max_span:
        return []
    samples = cache.window(gap_start, gap_end)
    levels = frame_rms_db(samples, frame, hop, max_frames=max_frames)
    if levels.size == 0:
        return []
    noise = float(np.percentile(levels, _NOISE_PERCENTILE))
    if float(np.max(levels)) - noise < _MIN_CONTRAST_DB:
        return []
    floor = max(_ABS_FLOOR_DB, noise + _ACTIVE_MARGIN_DB)
    # Bridge only very short dips; do not turn two unrelated noises into one hit.
    active = bridge_short_dips(levels >= floor, max(1, round(_BRIDGE_SEC / _HOP_SEC)))
    runs: list[AcousticGapRun] = []
    for i, j in bool_runs(active):
        start = gap_start + i * hop / sr
        end = min(gap_end, gap_start + ((j - 1) * hop + frame) / sr)
        dur = end - start
        if not (min_run_sec <= dur <= max_run_sec) or dur > _MAX_GAP_COVERAGE * gap:
            continue
        if not _run_is_voiced(samples, sr, i, j, hop):
            continue
        confidence = (float(np.mean(levels[i:j])) - floor) / 24.0
        runs.append(
            AcousticGapRun(start=start, end=end, confidence=min(0.99, max(0.2, confidence)))
        )
    return runs
