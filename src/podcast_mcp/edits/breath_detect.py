from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.util.dsp import (
    bool_runs,
    db_to_amplitude,
    high_band_energy_fraction,
    voicing_probes,
)
from podcast_mcp.util.tracks import track_audio_path

if TYPE_CHECKING:
    from podcast_mcp.engines.vad_silero import SileroVAD

log = logging.getLogger(__name__)

# A breath is unvoiced noise. Any 40 ms probe at or above this normalized
# speech-pitch autocorrelation peak marks a run as speech, never breath. The
# level band alone cannot tell them apart: in a loud window it selects the
# quieter frames of ordinary speech (#798). On the lab tape, kept words it
# labelled "breath" peak at 0.60-0.94 while real breaths stay at or below 0.45.
_CLEAR_PITCH_PEAK = 0.55
_PITCH_FRAME_SEC = 0.04
_PITCH_HOP_SEC = 0.01
_PITCH_FMIN_HZ = 70.0
_PITCH_FMAX_HZ = 350.0
# Sibilants are unvoiced too, but their energy sits above 4 kHz where a breath's
# does not: on the lab tape the `s` of a kept "let's" or "just" next to a cut
# carries 54-100% of its 100 Hz-8 kHz energy above the split, real breaths 1-24%.
_SIBILANT_SPLIT_HZ = 4000.0
_SIBILANT_HIGH_BAND_FRACTION = 0.5
_BREATH_BAND_HZ = (100.0, 8000.0)


@dataclass(frozen=True)
class BreathSpan:
    start: float
    end: float
    side: str


def _breath_cfg(defaults: dict | None) -> dict:
    cfg = (
        (defaults if defaults is not None else load_defaults())
        .get("tighten", {})
        .get("breath_handling", {})
    )
    return {
        "enabled": bool(cfg.get("enabled", True)),
        "search_before_ms": int(cfg.get("search_before_ms", 400)),
        "search_after_ms": int(cfg.get("search_after_ms", 250)),
        "min_duration_ms": int(cfg.get("min_duration_ms", 80)),
        "max_duration_ms": int(cfg.get("max_duration_ms", 450)),
        "attenuate_loud_breaths": bool(cfg.get("attenuate_loud_breaths", False)),
        "attenuate_db": float(cfg.get("attenuate_db", -9.0)),
        # "heuristic" (default, RMS-percentile band) or "silero" (VAD speech-probability
        # dip). Silero is opt-in: it needs real audio to tune the probability band
        # (see docs/audio-engineering.md), so it never changes default behavior.
        "vad_backend": str(cfg.get("vad_backend", "heuristic")),
    }


def _frame_rms(samples: np.ndarray, frame: int, frame_size: int) -> float:
    start = frame * frame_size
    end = min(samples.size, start + frame_size)
    if end <= start:
        return 0.0
    chunk = samples[start:end]
    return float(np.sqrt(np.mean(chunk**2)))


def _is_unvoiced(samples: np.ndarray, sample_rate: int) -> bool:
    probes = voicing_probes(
        samples,
        sample_rate,
        probe_sec=_PITCH_FRAME_SEC,
        hop_sec=_PITCH_HOP_SEC,
        fmin=_PITCH_FMIN_HZ,
        fmax=_PITCH_FMAX_HZ,
    )
    return probes.size == 0 or float(probes.max()) < _CLEAR_PITCH_PEAK


def _is_sibilant(samples: np.ndarray, sample_rate: int) -> bool:
    lo_hz, hi_hz = _BREATH_BAND_HZ
    fraction = high_band_energy_fraction(
        samples,
        sample_rate,
        split_hz=_SIBILANT_SPLIT_HZ,
        lo_hz=lo_hz,
        hi_hz=min(hi_hz, sample_rate / 2),
    )
    return fraction >= _SIBILANT_HIGH_BAND_FRACTION


def _breath_run_predicate(
    samples: np.ndarray, sample_rate: int, frame_size: int, cut_edge: str | None
) -> Callable[[int, int], bool]:
    """Predicate over frame runs: the run is breath-shaped and unvoiced all the way to the cut.

    ``cut_edge`` is the window edge the cut touches: ``"end"`` for a window before
    the cut, ``"start"`` for one after it, ``None`` when the window is the candidate
    itself. The cut is extended out to the run, so audio between them is removed too.
    """

    def accept(start: int, end: int) -> bool:
        run = samples[start * frame_size : end * frame_size]
        lo = 0 if cut_edge == "start" else start * frame_size
        hi = samples.size if cut_edge == "end" else end * frame_size
        return not _is_sibilant(run, sample_rate) and _is_unvoiced(samples[lo:hi], sample_rate)

    return accept


def _first_breath_span(
    active: np.ndarray,
    window_start: float,
    frame_duration: float,
    min_duration_sec: float,
    max_duration_sec: float,
    accept: Callable[[int, int], bool],
) -> BreathSpan | None:
    """First active run of breath length that ``accept(start_frame, end_frame)`` passes."""
    for start, end in bool_runs(active):
        duration = (end - start) * frame_duration
        if min_duration_sec <= duration <= max_duration_sec and accept(start, end):
            return BreathSpan(
                start=window_start + start * frame_duration,
                end=window_start + end * frame_duration,
                side="detected",
            )
    return None


def _find_breath_in_window(
    samples: np.ndarray,
    window_start: float,
    *,
    sample_rate: int,
    noise_floor: float,
    speech_rms: float,
    min_duration_sec: float,
    max_duration_sec: float,
    percentile: float = 25.0,
    cut_edge: str | None = None,
) -> BreathSpan | None:
    frame_size = max(1, int(sample_rate * 0.01))
    if samples.size < frame_size * 3:
        return None

    rms_values = [_frame_rms(samples, f, frame_size) for f in range(samples.size // frame_size)]
    if not rms_values:
        return None

    lo = max(noise_floor * 3, np.percentile(rms_values, percentile))
    hi = speech_rms * 0.45
    if hi <= lo:
        hi = lo * 4

    active = np.asarray([lo <= rms <= hi for rms in rms_values], dtype=bool)
    return _first_breath_span(
        active,
        window_start,
        frame_size / sample_rate,
        min_duration_sec,
        max_duration_sec,
        _breath_run_predicate(samples, sample_rate, frame_size, cut_edge),
    )


def _find_breath_in_window_silero(
    samples: np.ndarray,
    window_start: float,
    *,
    min_duration_sec: float,
    max_duration_sec: float,
    vad: SileroVAD | None = None,
    cut_edge: str | None = None,
) -> BreathSpan | None:
    """Locate a breath as a dip in Silero VAD speech-probability.

    Breaths are voiced-adjacent noise: typically low-but-nonzero speech
    probability, distinguishable from true silence (near 0) and full speech
    (near 1). The probability band below is a starting point, not a tuned
    constant -- see docs/audio-engineering.md for how to tune it by ear.
    """
    from podcast_mcp.engines.vad_silero import SileroVAD, get_shared_vad

    if vad is None:
        vad = get_shared_vad()
    if vad is None:
        return None
    probs = vad.speech_probs(samples)
    if probs.size == 0:
        return None
    window = SileroVAD.WINDOW_SAMPLES
    lo, hi = 0.05, 0.5

    active = (lo <= probs) & (probs <= hi)
    return _first_breath_span(
        active,
        window_start,
        window / SileroVAD.SAMPLE_RATE,
        min_duration_sec,
        max_duration_sec,
        _breath_run_predicate(samples, SileroVAD.SAMPLE_RATE, window, cut_edge),
    )


def classify_breath_samples(
    samples: np.ndarray,
    window_start: float,
    *,
    sample_rate: int,
    vad_backend: str = "heuristic",
    defaults: dict | None = None,
    min_duration_sec: float = 0.08,
    max_duration_sec: float = 0.45,
    candidate_run: bool = False,
    speech_reference_rms: float | None = None,
    cut_edge: str | None = None,
) -> BreathSpan | None:
    """Classify a bounded sample window using the shared breath detectors.

    Callers choose the window: a hit outside that window cannot classify it.
    ``cut_edge`` names the window edge that touches the cut being extended
    (``"end"`` before it, ``"start"`` after it); a hit then also needs unvoiced
    audio all the way to that edge. Silero is only used at its required 16 kHz
    rate with its model available.
    """
    if vad_backend == "silero" and sample_rate == 16000:
        from podcast_mcp.engines.vad_silero import get_shared_vad

        # Model construction or inference can fail after the package check.
        try:
            vad = get_shared_vad()
            if vad is not None:
                return _find_breath_in_window_silero(
                    samples,
                    window_start,
                    min_duration_sec=min_duration_sec,
                    max_duration_sec=max_duration_sec,
                    vad=vad,
                    cut_edge=cut_edge,
                )
        except Exception:
            log.debug("Silero breath inference failed; using RMS heuristic", exc_info=True)

    heuristics = (
        (defaults if defaults is not None else load_defaults())
        .get("analysis", {})
        .get("heuristics", {})
    )
    audibility_db = float(heuristics.get("audibility_rms_db", -42.0))
    if candidate_run:
        if speech_reference_rms is None or not np.isfinite(speech_reference_rms):
            return None
        speech_rms = speech_reference_rms
        noise_floor = speech_reference_rms * 0.01
    else:
        noise_floor = db_to_amplitude(audibility_db)
        speech_rms = noise_floor * 8.0
    # The percentile fallback in the adjacent-cut scanner deliberately widens
    # its band in loud windows. For a window wholly inside an acoustic run,
    # that would mislabel ordinary speech as breath; its RMS must remain below
    # the speech boundary before the shape scan is useful.
    if candidate_run:
        if not samples.size or not np.all(np.isfinite(samples)):
            return None
        if float(np.sqrt(np.mean(samples**2))) > speech_rms * 0.45:
            return None
        # The run already passed a permissive voicing check; clear pitch anywhere
        # in it keeps the whole candidate reviewable rather than calling it breath.
        if not _is_unvoiced(samples, sample_rate):
            return None
    return _find_breath_in_window(
        samples,
        window_start,
        sample_rate=sample_rate,
        noise_floor=noise_floor,
        speech_rms=speech_rms,
        min_duration_sec=min_duration_sec,
        max_duration_sec=max_duration_sec,
        percentile=10.0 if candidate_run else 25.0,
        cut_edge=cut_edge,
    )


def detect_adjacent_breath(
    project,
    track_id: str,
    cut_start: float,
    cut_end: float,
    *,
    defaults: dict | None = None,
    sample_rate: int = 16000,
    audio_cache: TrackAudioCache | None = None,
) -> list[BreathSpan]:
    cfg = _breath_cfg(defaults)
    if not cfg["enabled"]:
        return []

    min_dur = cfg["min_duration_ms"] / 1000.0
    max_dur = cfg["max_duration_ms"] / 1000.0

    def _find(samples: np.ndarray, window_start: float, cut_edge: str) -> BreathSpan | None:
        return classify_breath_samples(
            samples,
            window_start,
            sample_rate=sample_rate,
            vad_backend=cfg["vad_backend"],
            defaults=defaults,
            min_duration_sec=min_dur,
            max_duration_sec=max_dur,
            cut_edge=cut_edge,
        )

    use_cache = audio_cache is not None and audio_cache.waveform.sample_rate == sample_rate
    path: Path | None = None
    if not use_cache:
        try:
            path = track_audio_path(project, track_id)
        except ValueError:
            return []

    def _read(start_sec: float, duration_sec: float) -> np.ndarray:
        if use_cache:
            assert audio_cache is not None
            return audio_cache.window(start_sec, start_sec + duration_sec)
        assert path is not None
        return load_mono_window(
            path, start_sec=start_sec, duration_sec=duration_sec, sample_rate=sample_rate
        )

    spans: list[BreathSpan] = []
    before_sec = cfg["search_before_ms"] / 1000.0
    after_sec = cfg["search_after_ms"] / 1000.0

    before_start = max(0.0, cut_start - before_sec)
    before_dur = cut_start - before_start
    if before_dur > min_dur:
        samples = _read(before_start, before_dur)
        hit = _find(samples, before_start, "end")
        if hit:
            spans.append(BreathSpan(start=hit.start, end=hit.end, side="before"))

    after_dur = after_sec
    if after_dur > min_dur:
        samples = _read(cut_end, after_dur)
        hit = _find(samples, cut_end, "start")
        if hit:
            spans.append(BreathSpan(start=hit.start, end=hit.end, side="after"))

    return spans


def extend_cut_for_breaths(
    start: float,
    end: float,
    breaths: list[BreathSpan],
) -> tuple[float, float]:
    if not breaths:
        return start, end
    new_start = start
    new_end = end
    for span in breaths:
        if span.end <= start + 1e-3 or span.start >= end - 1e-3:
            if span.side == "before" or span.end <= start + 1e-3:
                new_start = min(new_start, span.start)
            if span.side == "after" or span.start >= end - 1e-3:
                new_end = max(new_end, span.end)
        else:
            new_start = min(new_start, span.start)
            new_end = max(new_end, span.end)
    if new_end <= new_start + 1e-4:
        return start, end
    return new_start, new_end
