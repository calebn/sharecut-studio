"""Bounded, local-only detection of voiced audio inside ASR gaps.

This is deliberately a *candidate* detector.  It does not infer a word and its
results always require review; ASR-free VAD commonly labels breaths and noise.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import numpy as np

from podcast_mcp.config.defaults import EffectiveConfig, bounded_float
from podcast_mcp.edits.acoustic_laugh import has_laugh_bursts
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.breath_detect import classify_breath_samples
from podcast_mcp.edits.room_model import BREATH_BELOW_SPEECH_DB
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
# A run this close to the seam between two scan windows may be cut short by it.
_SEAM_SEC = _FRAME_SEC
# Noise estimate: a low percentile of the gap's frame levels.
_NOISE_PERCENTILE = 20.0
# The loudest frame must stand this far above the gap's noise estimate; a flat
# level (hum, HVAC, steady bleed) never yields a candidate.
_MIN_CONTRAST_DB = 12.0
# Active frames must clear the noise estimate by this margin.
_ACTIVE_MARGIN_DB = 8.0
# Active frames also sit at least as far under the track's own speech level as the deepest
# breath does, so a gated track, whose gap noise estimate is digital silence, still has a
# floor to clear.
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
    vad_backend: str = "heuristic"
    word_probe: bool = True

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
            vad_backend=("silero" if raw.get("vad_backend") == "silero" else "heuristic"),
            word_probe=bool(raw.get("word_probe", base.word_probe)),
        )


@dataclass(frozen=True)
class AcousticGapRun:
    start: float
    end: float
    confidence: float
    likely_laugh: bool = False


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
    vad_backend: str = "heuristic",
    defaults: EffectiveConfig,
    speech_reference_rms: float | None = None,
    on_breath_rejected: Callable[[], None] | None = None,
) -> list[AcousticGapRun]:
    """Find short voiced runs wholly inside one inter-word gap.

    A gap longer than ``max_frames`` frames is scanned in overlapping windows of that
    size, so the cost of one scan stays bounded however long the speaker is silent. The
    windows overlap by more than the longest run, so every run is seen whole in one of
    them; a run that touches the seam between two windows is left to the window that holds
    it whole. Each window is judged on its own level: a gap is flat (hum, HVAC, steady
    bleed) and rejected by the contrast check, active frames must clear a low-percentile
    noise estimate, runs covering most of the window are rejected as plateaus, and each
    run must pass a speech-pitch periodicity check (rejecting white noise and most
    breaths). A run whose level bursts like a laugh is marked ``likely_laugh``
    (``edits/acoustic_laugh.py``). The scan never reads beyond the cache's decoded source span.
    """
    gap = gap_end - gap_start
    if gap < min_gap_sec or gap <= 0:
        return []
    sr = int(cache.waveform.sample_rate)
    frame = max(1, round(sr * _FRAME_SEC))
    hop = max(1, round(sr * _HOP_SEC))
    window_sec = (max_frames - 1) * hop / sr + frame / sr

    def scan(start: float, end: float) -> list[AcousticGapRun]:
        return _scan_window(
            cache,
            start,
            end,
            frame=frame,
            hop=hop,
            max_frames=max_frames,
            min_run_sec=min_run_sec,
            max_run_sec=max_run_sec,
            vad_backend=vad_backend,
            defaults=defaults,
            speech_reference_rms=speech_reference_rms,
            on_breath_rejected=on_breath_rejected,
        )

    if gap <= window_sec:
        return scan(gap_start, gap_end)
    stride = window_sec - (max_run_sec + 2 * _SEAM_SEC)
    if stride <= 0:
        return []
    runs: list[AcousticGapRun] = []
    w_start = gap_start
    while True:
        w_end = min(w_start + window_sec, gap_end)
        w_start = max(gap_start, w_end - window_sec)
        for run in scan(w_start, w_end):
            if (w_start > gap_start and run.start < w_start + _SEAM_SEC) or (
                w_end < gap_end and run.end > w_end - _SEAM_SEC
            ):
                continue
            if runs and run.start < runs[-1].end:
                continue
            runs.append(run)
        if w_end >= gap_end:
            return runs
        w_start += stride


def _scan_window(
    cache: TrackAudioCache,
    start: float,
    end: float,
    *,
    frame: int,
    hop: int,
    max_frames: int,
    min_run_sec: float,
    max_run_sec: float,
    vad_backend: str,
    defaults: EffectiveConfig,
    speech_reference_rms: float | None,
    on_breath_rejected: Callable[[], None] | None,
) -> list[AcousticGapRun]:
    """The voiced runs inside one window of at most ``max_frames`` frames."""
    sr = int(cache.waveform.sample_rate)
    window = end - start
    samples = cache.window(start, end)
    levels = frame_rms_db(
        samples,
        frame,
        hop,
        max_frames=max_frames,
        floor_db=cache.profile.room_db,
    )
    if levels.size == 0:
        return []
    noise = float(np.percentile(levels, _NOISE_PERCENTILE))
    if float(np.max(levels)) - noise < _MIN_CONTRAST_DB:
        return []
    floor = max(cache.profile.speech_db - BREATH_BELOW_SPEECH_DB[1], noise + _ACTIVE_MARGIN_DB)
    # Bridge only very short dips; do not turn two unrelated noises into one hit.
    active = bridge_short_dips(levels >= floor, max(1, round(_BRIDGE_SEC / _HOP_SEC)))
    runs: list[AcousticGapRun] = []
    for i, j in bool_runs(active):
        run_start = start + i * hop / sr
        run_end = min(end, start + ((j - 1) * hop + frame) / sr)
        dur = run_end - run_start
        if not (min_run_sec <= dur <= max_run_sec) or dur > _MAX_GAP_COVERAGE * window:
            continue
        if not _run_is_voiced(samples, sr, i, j, hop):
            continue
        # Classify only this run. A separate breath elsewhere in the gap must
        # not veto a voiced candidate at a different time.
        run_samples = cache.window(run_start, run_end)
        if (
            classify_breath_samples(
                run_samples,
                run_start,
                sample_rate=sr,
                vad_backend=vad_backend,
                defaults=defaults,
                candidate_run=True,
                speech_reference_rms=speech_reference_rms,
            )
            is not None
        ):
            if on_breath_rejected is not None:
                on_breath_rejected()
            continue
        confidence = (float(np.mean(levels[i:j])) - floor) / 24.0
        runs.append(
            AcousticGapRun(
                start=run_start,
                end=run_end,
                confidence=min(0.99, max(0.2, confidence)),
                likely_laugh=has_laugh_bursts(levels[i:j]),
            )
        )
    return runs
