"""Segment-level prosody profile: pitch, rate, pauses, energy, voice quality.

Backend is ``praat-parselmouth`` only (the optional ``prosody`` extra), no torch,
no openSMILE (it would duplicate these features and ship a second native binary).
See #196 and ``docs/pipeline.md`` § Prosody profile.

Public API: :class:`ProsodyParams`, :class:`WordSpan`, :func:`parselmouth_version`,
:class:`ProsodyUnavailable`, :func:`analyze_prosody`. Callers that cache the result
(``edits/prosody_profile.py``) own the audio-identity/cache bookkeeping; this module
only computes.

Segments come from word gaps (``segment_gap_sec`` merges close words, ``max_segment_sec``
splits long runs) when word timings are given, else from energy runs (``util.dsp.bool_runs``
over a floor-dB mask) so the step still produces a coarse profile pre-transcript.

Per segment: F0 (mean/median Hz, sd/range in semitones, voiced fraction) via
``Sound.to_pitch_ac``; speaking/articulation rate via a De Jong & Wempe-style
intensity-peak syllable-nucleus count (``Sound.to_intensity``, gated by voicing);
pauses (interior sub-floor runs >= ``pause_min_sec``); energy (mean/sd/slope/thirds/
trend); voice quality (jitter/shimmer/HNR via ``Sound.to_harmonicity_cc`` and
``To PointProcess (periodic, cc)``, flagged against Praat's standard voice-report
thresholds); prominent words (z-score fusion of F0 peak, energy peak, and duration
per syllable, when words are given); and boundary strength (weighted pause +
pre-boundary lengthening + pitch reset), always including the segment end.

No NaN is ever returned: every stat falls back to 0.0 (or an empty list) when the
segment has no voiced frames, no words, or too few samples to measure.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

from podcast_mcp.config import load_defaults
from podcast_mcp.util.dsp import bool_runs, clamp01, frame_rms_db

try:  # pragma: no cover - exercised via ProsodyUnavailable / importorskip paths
    import parselmouth
    from parselmouth.praat import call as praat_call
except ImportError:  # pragma: no cover
    parselmouth = None  # type: ignore[assignment]
    praat_call = None  # type: ignore[assignment]

# De Jong & Wempe (2009) syllable-nucleus defaults: intensity peaks at least
# MIN_DIP_DB above the preceding trough, within SILENCE_CEILING_DB of the
# segment's own intensity ceiling, and coincident with a voiced pitch frame.
_MIN_DIP_DB = 2.0
_SILENCE_CEILING_DB = 25.0
# Praat "Voice report" normal-range thresholds (jitter/shimmer local, HNR).
_JITTER_NORMAL_MAX = 0.0104
_SHIMMER_NORMAL_MAX = 0.0381
_HNR_NORMAL_MIN_DB = 7.0
_JITTER_ARGS = (0.0001, 0.02, 1.3)
_SHIMMER_ARGS = (0.0001, 0.02, 1.3, 1.6)


class ProsodyUnavailable(RuntimeError):
    """``praat-parselmouth`` is not installed (the ``prosody`` optional extra)."""


def parselmouth_version() -> str | None:
    """Installed parselmouth version, or None when the ``prosody`` extra is absent."""
    if parselmouth is None:
        return None
    return getattr(parselmouth, "__version__", None)


def _require_parselmouth() -> None:
    if parselmouth is None or praat_call is None:
        raise ProsodyUnavailable(
            "praat-parselmouth is not installed; install the 'prosody' extra "
            "(uv sync --extra prosody) to compute prosody profiles."
        )


@dataclass(frozen=True)
class WordSpan:
    """One transcript word, source-clock seconds."""

    text: str
    start: float
    end: float


@dataclass(frozen=True)
class ProsodyParams:
    pitch_floor_hz: float = 75.0
    pitch_ceiling_hz: float = 500.0
    segment_gap_sec: float = 1.0
    max_segment_sec: float = 30.0
    pause_min_sec: float = 0.25
    top_prominent_words: int = 5
    boundary_min_strength: float = 0.3

    @classmethod
    def from_defaults(cls, defaults: dict[str, Any] | None = None) -> ProsodyParams:
        cfg = (defaults if defaults is not None else load_defaults()).get("prosody", {})
        return cls(
            pitch_floor_hz=float(cfg.get("pitch_floor_hz", 75.0)),
            pitch_ceiling_hz=float(cfg.get("pitch_ceiling_hz", 500.0)),
            segment_gap_sec=float(cfg.get("segment_gap_sec", 1.0)),
            max_segment_sec=float(cfg.get("max_segment_sec", 30.0)),
            pause_min_sec=float(cfg.get("pause_min_sec", 0.25)),
            top_prominent_words=int(cfg.get("top_prominent_words", 5)),
            boundary_min_strength=float(cfg.get("boundary_min_strength", 0.3)),
        )

    def key(self) -> dict[str, float | int]:
        """A cache-input snapshot (algorithm parameters only, no paths)."""
        return {
            "pitch_floor_hz": self.pitch_floor_hz,
            "pitch_ceiling_hz": self.pitch_ceiling_hz,
            "segment_gap_sec": self.segment_gap_sec,
            "max_segment_sec": self.max_segment_sec,
            "pause_min_sec": self.pause_min_sec,
            "top_prominent_words": self.top_prominent_words,
            "boundary_min_strength": self.boundary_min_strength,
        }


def _finite(value: float, default: float = 0.0) -> float:
    return float(value) if math.isfinite(value) else default


def _safe_div(num: float, den: float, default: float = 0.0) -> float:
    return float(num) / float(den) if den > 1e-9 else default


_VOWEL_GROUPS = re.compile(r"[aeiouyAEIOUY]+")


def syllable_count_text(word: str) -> int:
    """A crude, dependency-free syllable estimate for one word (never below 1)."""
    text = word.strip().lower()
    if not text:
        return 1
    return max(1, len(_VOWEL_GROUPS.findall(text)))


def _segments_from_words(
    words: Sequence[WordSpan], *, gap_sec: float, max_sec: float, total_dur: float
) -> list[tuple[float, float]]:
    if not words:
        return []
    ordered = sorted(words, key=lambda w: w.start)
    segments: list[tuple[float, float]] = []
    seg_start = ordered[0].start
    seg_end = ordered[0].end
    for w in ordered[1:]:
        gap = w.start - seg_end
        if gap > gap_sec or (w.end - seg_start) > max_sec:
            segments.append((seg_start, seg_end))
            seg_start = w.start
        seg_end = max(seg_end, w.end)
    segments.append((seg_start, seg_end))
    return [(max(0.0, s), min(total_dur, e) if total_dur > 0 else e) for s, e in segments if e > s]


def _segments_from_energy(
    samples: np.ndarray,
    sr: int,
    *,
    gap_sec: float,
    max_sec: float,
    floor_db: float = -40.0,
) -> list[tuple[float, float]]:
    frame = max(1, int(0.025 * sr))
    hop = max(1, int(0.010 * sr))
    db = frame_rms_db(samples, frame, hop)
    if db.size == 0:
        return []
    runs = bool_runs(db > floor_db)
    if not runs:
        return []
    hop_sec = hop / float(sr)
    spans = [(s * hop_sec, e * hop_sec) for s, e in runs]
    merged: list[tuple[float, float]] = []
    for s, e in spans:
        if merged and s - merged[-1][1] <= gap_sec:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    out: list[tuple[float, float]] = []
    for s, e in merged:
        while e - s > max_sec:
            out.append((s, s + max_sec))
            s += max_sec
        if e > s:
            out.append((s, e))
    return out


def segment_bounds(
    words: Sequence[WordSpan],
    *,
    total_dur: float,
    params: ProsodyParams,
    samples: np.ndarray | None = None,
    sr: int | None = None,
) -> list[tuple[float, float]]:
    """Segment spans from word gaps, or from energy runs when there are no words."""
    if words:
        return _segments_from_words(
            words,
            gap_sec=params.segment_gap_sec,
            max_sec=params.max_segment_sec,
            total_dur=total_dur,
        )
    if samples is not None and sr:
        return _segments_from_energy(
            samples, sr, gap_sec=params.segment_gap_sec, max_sec=params.max_segment_sec
        )
    return []


def syllable_nuclei(
    times: np.ndarray,
    db: np.ndarray,
    voiced: np.ndarray,
    *,
    min_dip_db: float = _MIN_DIP_DB,
    silence_ceiling_db: float = _SILENCE_CEILING_DB,
) -> int:
    """De Jong & Wempe-style count of intensity peaks that are voiced and loud enough.

    Pure numpy: a peak is registered when the contour rises by at least
    ``min_dip_db`` from the preceding trough, then falls; the peak frame must sit
    within ``silence_ceiling_db`` of the segment's own intensity ceiling and be
    voiced (a pitch-defined frame at or adjacent to the peak time).
    """
    if db.size < 2:
        return 0
    ceiling = float(np.max(db))
    floor = ceiling - silence_ceiling_db
    count = 0
    trough = db[0]
    rising = False
    for i in range(1, db.size):
        if db[i] > db[i - 1]:
            if not rising:
                trough = db[i - 1]
            rising = True
            continue
        if rising:
            peak_db = db[i - 1]
            if peak_db - trough >= min_dip_db and peak_db >= floor and voiced[i - 1]:
                count += 1
        rising = False
    return count


def _voiced_at(pitch_xs: np.ndarray, pitch_hz: np.ndarray, query_times: np.ndarray) -> np.ndarray:
    """Nearest-frame voiced flag (pitch > 0) for each of ``query_times``."""
    if pitch_xs.size == 0 or query_times.size == 0:
        return np.zeros(query_times.shape, dtype=bool)
    idx = np.searchsorted(pitch_xs, query_times)
    idx = np.clip(idx, 0, pitch_xs.size - 1)
    left = np.clip(idx - 1, 0, pitch_xs.size - 1)
    use_left = np.abs(pitch_xs[left] - query_times) <= np.abs(pitch_xs[idx] - query_times)
    chosen = np.where(use_left, left, idx)
    return pitch_hz[chosen] > 0


def _energy_stats(times: np.ndarray, db: np.ndarray, start: float, end: float) -> dict[str, Any]:
    mask = (times >= start) & (times < end)
    seg = db[mask]
    seg_t = times[mask]
    if seg.size == 0:
        return {
            "mean_db": 0.0,
            "sd_db": 0.0,
            "slope_db_per_sec": 0.0,
            "start_third_db": 0.0,
            "mid_third_db": 0.0,
            "end_third_db": 0.0,
            "drop_db": 0.0,
            "trend": "flat",
        }
    mean_db = _finite(float(np.mean(seg)))
    sd_db = _finite(float(np.std(seg)))
    if seg.size >= 2 and float(np.ptp(seg_t)) > 1e-6:
        slope = _finite(float(np.polyfit(seg_t, seg, 1)[0]))
    else:
        slope = 0.0
    thirds = np.array_split(seg, 3) if seg.size >= 3 else [seg, seg, seg]
    start_third = _finite(float(np.mean(thirds[0])) if thirds[0].size else mean_db)
    mid_third = _finite(float(np.mean(thirds[1])) if thirds[1].size else mean_db)
    end_third = _finite(float(np.mean(thirds[2])) if thirds[2].size else mean_db)
    drop_db = _finite(start_third - end_third)
    trend = "falling" if drop_db > 1.5 else "rising" if drop_db < -1.5 else "flat"
    return {
        "mean_db": mean_db,
        "sd_db": sd_db,
        "slope_db_per_sec": slope,
        "start_third_db": start_third,
        "mid_third_db": mid_third,
        "end_third_db": end_third,
        "drop_db": drop_db,
        "trend": trend,
    }


def _pause_runs(
    times: np.ndarray, db: np.ndarray, start: float, end: float, *, min_sec: float, floor_db: float
) -> tuple[int, float]:
    mask = (times >= start) & (times < end)
    seg = db[mask]
    seg_t = times[mask]
    if seg.size < 2:
        return 0, 0.0
    dt = float(np.median(np.diff(seg_t))) if seg.size > 1 else 0.0
    if dt <= 0:
        return 0, 0.0
    runs = bool_runs(seg < floor_db)
    count = 0
    total = 0.0
    n = seg.size
    for s, e in runs:
        if s == 0 or e >= n:
            continue  # not interior: touches the segment edge
        dur = (e - s) * dt
        if dur >= min_sec:
            count += 1
            total += dur
    return count, _finite(total)


def _voice_quality(
    *,
    jitter: float | None,
    shimmer: float | None,
    hnr: float | None,
) -> dict[str, Any]:
    jitter_v = _finite(jitter) if jitter is not None else 0.0
    shimmer_v = _finite(shimmer) if shimmer is not None else 0.0
    hnr_v = _finite(hnr) if hnr is not None else 0.0
    return {
        "jitter_local": jitter_v,
        "shimmer_local": shimmer_v,
        "hnr_db": hnr_v,
        "jitter_high": jitter is not None and jitter_v > _JITTER_NORMAL_MAX,
        "shimmer_high": shimmer is not None and shimmer_v > _SHIMMER_NORMAL_MAX,
        "hnr_low": hnr is not None and hnr_v < _HNR_NORMAL_MIN_DB,
    }


def _zscore(values: list[float]) -> list[float]:
    if not values:
        return []
    arr = np.asarray(values, dtype=np.float64)
    mean = float(np.mean(arr))
    sd = float(np.std(arr))
    if sd < 1e-9:
        return [0.0] * len(values)
    return [_finite(float((v - mean) / sd)) for v in arr]


def _prominent_words(
    words: Sequence[WordSpan], pitch: Any, intensity: Any, *, top_n: int
) -> list[dict[str, Any]]:
    if not words or praat_call is None:
        return []
    f0_peaks: list[float] = []
    energy_peaks: list[float] = []
    dur_per_syl: list[float] = []
    for w in words:
        try:
            f0 = praat_call(pitch, "Get maximum", w.start, w.end, "Hertz", "Parabolic")
        except Exception:
            f0 = 0.0
        try:
            en = praat_call(intensity, "Get maximum", w.start, w.end, "dB", "Parabolic")
        except Exception:
            en = 0.0
        f0_peaks.append(_finite(f0 if f0 is not None else 0.0))
        energy_peaks.append(_finite(en if en is not None else 0.0))
        syl = syllable_count_text(w.text)
        dur_per_syl.append(_safe_div(w.end - w.start, syl))
    scores = [
        a + b + c
        for a, b, c in zip(
            _zscore(f0_peaks), _zscore(energy_peaks), _zscore(dur_per_syl), strict=True
        )
    ]
    ranked = sorted(
        zip(words, scores, strict=True),
        key=lambda pair: pair[1],
        reverse=True,
    )
    return [
        {
            "text": w.text,
            "start": w.start,
            "end": w.end,
            "score": round(score, 3),
        }
        for w, score in ranked[:top_n]
    ]


def _boundaries(
    words: Sequence[WordSpan],
    pitch: Any,
    *,
    seg_start: float,
    seg_end: float,
    min_strength: float,
) -> list[dict[str, Any]]:
    if not words:
        return [
            {
                "time": seg_end,
                "strength": 1.0,
                "pause_sec": 0.0,
                "lengthening": 0.0,
                "pitch_reset": 0.0,
                "kind": "segment_end",
            }
        ]
    ordered = sorted(words, key=lambda w: w.start)
    dur_per_syl = [_safe_div(w.end - w.start, syllable_count_text(w.text)) for w in ordered]
    dur_z = _zscore(dur_per_syl)
    out: list[dict[str, Any]] = []
    for i in range(len(ordered) - 1):
        cur, nxt = ordered[i], ordered[i + 1]
        pause_sec = max(0.0, nxt.start - cur.end)
        pause_score = clamp01(_safe_div(pause_sec, 1.0))
        lengthening = clamp01(0.5 + dur_z[i] / 4.0)
        pitch_reset = 0.0
        if praat_call is not None:
            try:
                f0_end = praat_call(pitch, "Get value at time", cur.end, "Hertz", "Linear")
                f0_start = praat_call(pitch, "Get value at time", nxt.start, "Hertz", "Linear")
            except Exception:
                f0_end = f0_start = None
            if f0_end and f0_start and f0_end > 0 and f0_start > 0:
                semitones = abs(12.0 * math.log2(f0_start / f0_end))
                pitch_reset = clamp01(semitones / 12.0)
        strength = 0.5 * pause_score + 0.3 * lengthening + 0.2 * pitch_reset
        if strength >= min_strength or pause_sec > 0:
            out.append(
                {
                    "time": cur.end,
                    "strength": round(_finite(strength), 3),
                    "pause_sec": round(pause_sec, 3),
                    "lengthening": round(lengthening, 3),
                    "pitch_reset": round(pitch_reset, 3),
                    "kind": "word_gap",
                }
            )
    out.append(
        {
            "time": seg_end,
            "strength": 1.0,
            "pause_sec": 0.0,
            "lengthening": 0.0,
            "pitch_reset": 0.0,
            "kind": "segment_end",
        }
    )
    return out


def _f0_stats(
    pitch: Any, xs: np.ndarray, freqs: np.ndarray, start: float, end: float
) -> dict[str, Any]:
    mask = (xs >= start) & (xs < end)
    seg = freqs[mask]
    voiced = seg[seg > 0]
    voiced_fraction = _safe_div(voiced.size, seg.size)
    if voiced.size == 0 or praat_call is None:
        return {
            "mean_hz": 0.0,
            "median_hz": 0.0,
            "sd_st": 0.0,
            "range_st": 0.0,
            "voiced_fraction": _finite(voiced_fraction),
        }
    try:
        mean_hz = praat_call(pitch, "Get mean", start, end, "Hertz") or 0.0
        sd_st = praat_call(pitch, "Get standard deviation", start, end, "semitones") or 0.0
        min_hz = praat_call(pitch, "Get minimum", start, end, "Hertz", "Parabolic") or 0.0
        max_hz = praat_call(pitch, "Get maximum", start, end, "Hertz", "Parabolic") or 0.0
    except Exception:
        mean_hz = float(np.mean(voiced))
        sd_st = 0.0
        min_hz = float(np.min(voiced))
        max_hz = float(np.max(voiced))
    range_st = 12.0 * math.log2(max_hz / min_hz) if min_hz > 0 and max_hz > 0 else 0.0
    return {
        "mean_hz": _finite(mean_hz),
        "median_hz": _finite(float(np.median(voiced))),
        "sd_st": _finite(sd_st),
        "range_st": _finite(range_st),
        "voiced_fraction": _finite(voiced_fraction),
    }


def analyze_prosody(
    samples: np.ndarray,
    sr: int,
    words: Sequence[WordSpan],
    params: ProsodyParams,
) -> dict[str, Any]:
    """Compute the prosody profile for one track's audio.

    ``samples`` is mono float audio at ``sr`` Hz (see ``engines.audio_audit.load_mono_full``).
    ``words`` are that same track's word timings in the same source-media clock
    (empty is fine; segments then come from energy runs). Raises
    :class:`ProsodyUnavailable` when ``praat-parselmouth`` is not installed.
    """
    _require_parselmouth()
    total_dur = float(samples.size) / float(sr) if sr else 0.0
    bounds = segment_bounds(words, total_dur=total_dur, params=params, samples=samples, sr=sr)
    if not bounds:
        return {
            "segments": [],
            "engine": {"backend": "parselmouth", "version": parselmouth_version()},
        }

    snd = parselmouth.Sound(samples.astype(np.float64), sampling_frequency=float(sr))
    pitch = snd.to_pitch_ac(
        pitch_floor=params.pitch_floor_hz,
        pitch_ceiling=params.pitch_ceiling_hz,
    )
    intensity = snd.to_intensity()
    harmonicity = snd.to_harmonicity_cc()
    point_process = praat_call(
        snd, "To PointProcess (periodic, cc)", params.pitch_floor_hz, params.pitch_ceiling_hz
    )

    pitch_xs = pitch.xs()
    pitch_hz = pitch.selected_array["frequency"]
    intensity_xs = intensity.xs()
    intensity_db = intensity.values[0]
    voiced_at_intensity = _voiced_at(pitch_xs, pitch_hz, intensity_xs)

    words_by_span: dict[tuple[float, float], list[WordSpan]] = {}
    if words:
        ordered = sorted(words, key=lambda w: w.start)
        for span in bounds:
            words_by_span[span] = [w for w in ordered if span[0] - 1e-6 <= w.start < span[1] + 1e-6]

    segments: list[dict[str, Any]] = []
    for start, end in bounds:
        seg_words = words_by_span.get((start, end), [])
        mask = (intensity_xs >= start) & (intensity_xs < end)
        seg_db = intensity_db[mask]
        seg_voiced = voiced_at_intensity[mask]
        seg_times = intensity_xs[mask]
        n_syllables = syllable_nuclei(seg_times, seg_db, seg_voiced)
        duration = max(0.0, end - start)
        pause_count, pause_total = _pause_runs(
            intensity_xs,
            intensity_db,
            start,
            end,
            min_sec=params.pause_min_sec,
            floor_db=max(0.0, float(np.max(seg_db)) - _SILENCE_CEILING_DB) if seg_db.size else 0.0,
        )
        phonation_sec = max(0.0, duration - pause_total)
        try:
            jitter = praat_call(point_process, "Get jitter (local)", start, end, *_JITTER_ARGS)
        except Exception:
            jitter = None
        try:
            shimmer = praat_call(
                [snd, point_process], "Get shimmer (local)", start, end, *_SHIMMER_ARGS
            )
        except Exception:
            shimmer = None
        try:
            hnr = praat_call(harmonicity, "Get mean", start, end)
        except Exception:
            hnr = None
        segments.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "f0": _f0_stats(pitch, pitch_xs, pitch_hz, start, end),
                "rate": {
                    "syllable_count": n_syllables,
                    "speech_rate": _finite(_safe_div(n_syllables, duration)),
                    "articulation_rate": _finite(_safe_div(n_syllables, phonation_sec)),
                },
                "pauses": {"count": pause_count, "total_sec": round(pause_total, 3)},
                "energy": _energy_stats(intensity_xs, intensity_db, start, end),
                "voice_quality": _voice_quality(
                    jitter=jitter, shimmer=shimmer, hnr=hnr if hnr else None
                ),
                "prominent_words": _prominent_words(
                    seg_words, pitch, intensity, top_n=params.top_prominent_words
                ),
                "boundaries": _boundaries(
                    seg_words,
                    pitch,
                    seg_start=start,
                    seg_end=end,
                    min_strength=params.boundary_min_strength,
                ),
            }
        )

    return {
        "segments": segments,
        "engine": {"backend": "parselmouth", "version": parselmouth_version()},
    }
