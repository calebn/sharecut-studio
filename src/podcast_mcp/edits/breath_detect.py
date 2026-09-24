from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.util.dsp import bool_runs
from podcast_mcp.util.tracks import track_audio_path


@dataclass(frozen=True)
class BreathSpan:
    start: float
    end: float
    side: str


def _breath_cfg(defaults: dict | None) -> dict:
    cfg = (defaults or load_defaults()).get("tighten", {}).get("breath_handling", {})
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


def _first_breath_span(
    active: np.ndarray,
    window_start: float,
    frame_duration: float,
    min_duration_sec: float,
    max_duration_sec: float,
) -> BreathSpan | None:
    for start, end in bool_runs(active):
        duration = (end - start) * frame_duration
        if min_duration_sec <= duration <= max_duration_sec:
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
) -> BreathSpan | None:
    frame_size = max(1, int(sample_rate * 0.01))
    if samples.size < frame_size * 3:
        return None

    rms_values = [_frame_rms(samples, f, frame_size) for f in range(samples.size // frame_size)]
    if not rms_values:
        return None

    lo = max(noise_floor * 3, np.percentile(rms_values, 25))
    hi = speech_rms * 0.45
    if hi <= lo:
        hi = lo * 4

    active = np.asarray([lo <= rms <= hi for rms in rms_values], dtype=bool)
    return _first_breath_span(
        active, window_start, frame_size / sample_rate, min_duration_sec, max_duration_sec
    )


def _find_breath_in_window_silero(
    samples: np.ndarray,
    window_start: float,
    *,
    min_duration_sec: float,
    max_duration_sec: float,
) -> BreathSpan | None:
    """Locate a breath as a dip in Silero VAD speech-probability.

    Breaths are voiced-adjacent noise: typically low-but-nonzero speech
    probability, distinguishable from true silence (near 0) and full speech
    (near 1). The probability band below is a starting point, not a tuned
    constant -- see docs/audio-engineering.md for how to tune it by ear.
    """
    from podcast_mcp.engines.vad_silero import SileroVAD, get_shared_vad

    vad = get_shared_vad()
    if vad is None:
        return None
    probs = vad.speech_probs(samples)
    if probs.size == 0:
        return None
    window_dur = SileroVAD.WINDOW_SAMPLES / SileroVAD.SAMPLE_RATE
    lo, hi = 0.05, 0.5

    active = (lo <= probs) & (probs <= hi)
    return _first_breath_span(active, window_start, window_dur, min_duration_sec, max_duration_sec)


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

    heuristics = (defaults or load_defaults()).get("analysis", {}).get("heuristics", {})
    audibility_db = float(heuristics.get("audibility_rms_db", -42.0))
    noise_floor = 10 ** (audibility_db / 20.0)
    speech_rms = noise_floor * 8.0

    min_dur = cfg["min_duration_ms"] / 1000.0
    max_dur = cfg["max_duration_ms"] / 1000.0

    backend = cfg["vad_backend"]
    if backend == "silero":
        from podcast_mcp.engines.vad_silero import is_available as silero_available

        # Silero VAD only accepts its own 16kHz contract; fall back to the
        # heuristic rather than resample or silently skip detection.
        if sample_rate != 16000 or not silero_available():
            backend = "heuristic"

    def _find(samples: np.ndarray, window_start: float) -> BreathSpan | None:
        if backend == "silero":
            return _find_breath_in_window_silero(
                samples,
                window_start,
                min_duration_sec=min_dur,
                max_duration_sec=max_dur,
            )
        return _find_breath_in_window(
            samples,
            window_start,
            sample_rate=sample_rate,
            noise_floor=noise_floor,
            speech_rms=speech_rms,
            min_duration_sec=min_dur,
            max_duration_sec=max_dur,
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
        hit = _find(samples, before_start)
        if hit:
            spans.append(BreathSpan(start=hit.start, end=hit.end, side="before"))

    after_dur = after_sec
    if after_dur > min_dur:
        samples = _read(cut_end, after_dur)
        hit = _find(samples, cut_end)
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
