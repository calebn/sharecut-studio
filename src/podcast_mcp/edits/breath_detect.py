from __future__ import annotations

import logging
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.util.dsp import (
    bool_runs,
    db_to_amplitude,
    frame_rms_db,
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
# Only frames at or above the band floor are probed: room tone 40 dB under the
# speech level scores 0.6-0.8 on this tape too, and it is not speech to protect.
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
# A breath's level is only meaningful against the track's own room tone and speech.
# Both are read from the kept audio flanking a cut: 10 ms frames over this much on
# each side, the 10th percentile of live (not digitally silent) frames as the floor
# and the 90th as the speech level. On the lab tape breaths sit 6-39 dB below that
# speech level and 12-45 dB above that floor (#814); a fixed audibility floor put
# the band at -32.4 to -31 dBFS and found 1 of 26.
_LEVEL_CONTEXT_SEC = 5.0
_LEVEL_FRAME_SEC = 0.01
_MIN_LIVE_CONTEXT_SEC = 0.5
_FLOOR_PERCENTILE = 10.0
_SPEECH_PERCENTILE = 90.0
_DIGITAL_SILENCE_DB = -200.0
_BREATH_ABOVE_FLOOR_DB = 9.5
_BREATH_BELOW_SPEECH_DB = (7.0, 40.0)


@dataclass(frozen=True)
class BreathSpan:
    start: float
    end: float
    side: str


@dataclass(frozen=True)
class LevelBand:
    """Linear RMS interval a 10 ms frame must fall in to be part of a breath run."""

    lo: float
    hi: float


def breath_level_band(noise_floor_rms: float, speech_rms: float) -> LevelBand | None:
    """Band between the room tone and the speech level, or ``None`` without contrast."""
    quietest, loudest = _BREATH_BELOW_SPEECH_DB
    lo = max(
        noise_floor_rms * db_to_amplitude(_BREATH_ABOVE_FLOOR_DB),
        speech_rms * db_to_amplitude(-loudest),
    )
    hi = speech_rms * db_to_amplitude(-quietest)
    if not (0.0 < lo < hi):
        return None
    return LevelBand(lo=lo, hi=hi)


def level_profile(samples: np.ndarray, sample_rate: int) -> tuple[float, float] | None:
    """``(noise_floor_rms, speech_rms)`` of the live 10 ms frames, or ``None`` when too few."""
    frame = max(1, round(sample_rate * _LEVEL_FRAME_SEC))
    levels = frame_rms_db(samples, frame, frame, floor_db=_DIGITAL_SILENCE_DB)
    live = levels[levels > _DIGITAL_SILENCE_DB]
    if live.size < _MIN_LIVE_CONTEXT_SEC / _LEVEL_FRAME_SEC:
        return None
    floor_db, speech_db = np.percentile(live, (_FLOOR_PERCENTILE, _SPEECH_PERCENTILE))
    return db_to_amplitude(float(floor_db)), db_to_amplitude(float(speech_db))


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
        # "heuristic" (default, level band between the flanking room tone and speech
        # level) or "silero" (VAD speech-probability dip). Silero is opt-in: it needs
        # real audio to tune the probability band (see docs/audio-engineering.md), so
        # it never changes default behavior.
        "vad_backend": str(cfg.get("vad_backend", "heuristic")),
    }


def _frame_rms(samples: np.ndarray, frame: int, frame_size: int) -> float:
    start = frame * frame_size
    end = min(samples.size, start + frame_size)
    if end <= start:
        return 0.0
    chunk = samples[start:end]
    return float(np.sqrt(np.mean(chunk**2)))


def _frame_levels(samples: np.ndarray, frame_size: int, count: int) -> np.ndarray:
    return np.asarray([_frame_rms(samples, f, frame_size) for f in range(count)])


def _is_unvoiced(samples: np.ndarray, sample_rate: int, *, min_rms: float = 0.0) -> bool:
    """No speech-pitch probe at or above the gate, over probes whose level reaches ``min_rms``."""
    probes = voicing_probes(
        samples,
        sample_rate,
        probe_sec=_PITCH_FRAME_SEC,
        hop_sec=_PITCH_HOP_SEC,
        fmin=_PITCH_FMIN_HZ,
        fmax=_PITCH_FMAX_HZ,
    )
    if probes.size and min_rms > 0.0:
        frame = min(samples.size, max(1, round(sample_rate * _PITCH_FRAME_SEC)))
        hop = max(1, round(sample_rate * _PITCH_HOP_SEC))
        levels = frame_rms_db(samples, frame, hop, floor_db=_DIGITAL_SILENCE_DB)
        probes = probes[levels >= 20.0 * math.log10(min_rms)]
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


def _blocked_frames(
    keep_out: Sequence[tuple[float, float]], window_start: float, frame_duration: float, count: int
) -> np.ndarray:
    """Frame mask of a window: ``True`` where a frame overlaps a ``keep_out`` span."""
    blocked = np.zeros(count, dtype=bool)
    for start, end in keep_out:
        lo = max(0, math.floor((start - window_start) / frame_duration + 1e-9))
        hi = min(count, math.ceil((end - window_start) / frame_duration - 1e-9))
        if hi > lo:
            blocked[lo:hi] = True
    return blocked


def _joined_to_kept_word(
    levels: np.ndarray, blocked: np.ndarray, start: int, end: int, cut_edge: str, floor: float
) -> bool:
    """Whether the run continues a kept word on its far side without a return to the floor.

    Walking away from the cut from the run's far edge, a ``blocked`` frame reached
    before any frame at or below ``floor`` makes the run that word's decay (before
    the cut) or onset (after it), whatever its own shape.
    """
    walk = range(start - 1, -1, -1) if cut_edge == "end" else range(end, levels.size)
    for i in walk:
        if blocked[i]:
            return True
        if levels[i] <= floor:
            return False
    return False


def _breath_run_predicate(
    samples: np.ndarray,
    sample_rate: int,
    frame_size: int,
    cut_edge: str | None,
    *,
    blocked: np.ndarray,
    levels: np.ndarray | None = None,
    band: LevelBand | None = None,
    cut_sample: int | None = None,
) -> Callable[[int, int], bool]:
    """Predicate over frame runs: the run and the gap to the cut are breath-shaped and unvoiced.

    ``cut_edge`` is the protected side: ``"end"`` for a window before
    the cut, ``"start"`` for one after it, ``None`` when the window is the candidate
    itself. The cut is extended out to the run, so audio between them is removed too:
    nothing in the run or that gap may be a ``blocked`` frame (a kept transcript
    word), the gap is checked for sibilance on its own (a word-final ``s`` next to a
    loud breath would otherwise average out below the split) and for voicing together
    with the run, over probes at or above the band floor. With per-frame ``levels``
    and a ``band``, no gap frame may exceed the band ceiling (vocal fry between a
    breath and the cut scores 0.1-0.4 on the pitch probe but sits at speech level),
    and the run may not continue a kept word without the level first falling to the
    band floor (:func:`_joined_to_kept_word`). ``cut_sample`` locates a cut inside
    the window, where the full crossing run must be separate from kept words on
    both sides.
    """
    floor = band.lo if band is not None else 0.0
    edge = cut_sample if cut_sample is not None else (0 if cut_edge == "start" else samples.size)
    edge_frame = edge // frame_size

    def accept(start: int, end: int) -> bool:
        run_lo, run_hi = start * frame_size, end * frame_size
        if cut_edge == "start":
            gap = samples[edge:run_lo]
        elif cut_edge == "end":
            gap = samples[run_hi:edge]
        else:
            gap = samples[:0]
        lo = min(edge, run_lo) if cut_edge == "start" else run_lo
        hi = max(edge, run_hi) if cut_edge == "end" else run_hi
        first = min(edge_frame, start) if cut_edge == "start" else start
        last = max(edge_frame, end) if cut_edge == "end" else end
        if blocked[first:last].any():
            return False
        if levels is not None and band is not None:
            gap_levels = levels[edge_frame:start] if cut_edge == "start" else levels[end:edge_frame]
            if cut_edge is not None and (
                (gap_levels > band.hi).any()
                or _joined_to_kept_word(levels, blocked, start, end, cut_edge, band.lo)
            ):
                return False
            if cut_sample is not None and any(
                _joined_to_kept_word(levels, blocked, start, end, side, band.lo)
                for side in ("start", "end")
            ):
                return False
        return (
            not _is_sibilant(samples[run_lo:run_hi], sample_rate)
            and not _is_sibilant(gap, sample_rate)
            and _is_unvoiced(samples[lo:hi], sample_rate, min_rms=floor)
        )

    return accept


def _search_frames(
    search_sec: tuple[float, float] | None, window_start: float, frame_duration: float, count: int
) -> np.ndarray:
    """Frame mask of the frames lying inside ``search_sec`` (all frames when ``None``)."""
    if search_sec is None:
        return np.ones(count, dtype=bool)
    starts = window_start + np.arange(count) * frame_duration
    return (starts >= search_sec[0] - 1e-6) & (starts + frame_duration <= search_sec[1] + 1e-6)


def _first_breath_span(
    active: np.ndarray,
    window_start: float,
    frame_duration: float,
    min_duration_sec: float,
    max_duration_sec: float,
    accept: Callable[[int, int], bool],
    *,
    search_frames: np.ndarray,
    crossing_sec: float | None = None,
    crossing_refiner: Callable[[BreathSpan], BreathSpan | None] | None = None,
) -> BreathSpan | None:
    """First accepted run, refined before testing a requested crossing boundary."""
    for start, end in bool_runs(active):
        if not search_frames[start:end].any():
            continue
        start_sec = window_start + start * frame_duration
        end_sec = window_start + end * frame_duration
        duration = (end - start) * frame_duration
        if min_duration_sec <= duration <= max_duration_sec and accept(start, end):
            hit = BreathSpan(
                start=start_sec,
                end=end_sec,
                side="detected",
            )
            if crossing_sec is None:
                return hit
            if crossing_refiner is None:
                if start_sec < crossing_sec < end_sec:
                    return hit
                continue
            refined = crossing_refiner(hit)
            if refined is not None and refined.start < crossing_sec < refined.end:
                return refined
    return None


def _find_breath_in_window(
    samples: np.ndarray,
    window_start: float,
    *,
    sample_rate: int,
    band: LevelBand,
    min_duration_sec: float,
    max_duration_sec: float,
    cut_edge: str | None = None,
    keep_out: Sequence[tuple[float, float]] = (),
    search_sec: tuple[float, float] | None = None,
    crossing_sec: float | None = None,
    crossing_refiner: Callable[[BreathSpan], BreathSpan | None] | None = None,
) -> BreathSpan | None:
    """First complete in-band run overlapping ``search_sec`` that passes the predicate.

    The predicate sees every frame of ``samples``, so the window may carry audio
    beyond the search span for the kept-word adjacency walk.
    """
    frame_size = max(1, int(sample_rate * _LEVEL_FRAME_SEC))
    if samples.size < frame_size * 3:
        return None

    levels = _frame_levels(samples, frame_size, samples.size // frame_size)
    if not levels.size:
        return None

    frame_duration = frame_size / sample_rate
    blocked = _blocked_frames(keep_out, window_start, frame_duration, levels.size)
    active = (band.lo <= levels) & (levels <= band.hi)
    return _first_breath_span(
        active,
        window_start,
        frame_duration,
        min_duration_sec,
        max_duration_sec,
        _breath_run_predicate(
            samples,
            sample_rate,
            frame_size,
            cut_edge,
            blocked=blocked,
            levels=levels,
            band=band,
            cut_sample=(
                round((crossing_sec - window_start) * sample_rate)
                if crossing_sec is not None
                else None
            ),
        ),
        search_frames=_search_frames(search_sec, window_start, frame_duration, levels.size),
        crossing_sec=crossing_sec,
        crossing_refiner=crossing_refiner,
    )


def _find_breath_in_window_silero(
    samples: np.ndarray,
    window_start: float,
    *,
    min_duration_sec: float,
    max_duration_sec: float,
    vad: SileroVAD | None = None,
    cut_edge: str | None = None,
    keep_out: Sequence[tuple[float, float]] = (),
    search_sec: tuple[float, float] | None = None,
    band: LevelBand | None = None,
    crossing_sec: float | None = None,
    crossing_refiner: Callable[[BreathSpan], BreathSpan | None] | None = None,
) -> BreathSpan | None:
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

    frame_duration = window / SileroVAD.SAMPLE_RATE
    blocked = _blocked_frames(keep_out, window_start, frame_duration, probs.size)
    active = (lo <= probs) & (probs <= hi)
    levels = _frame_levels(samples, window, probs.size)
    return _first_breath_span(
        active,
        window_start,
        frame_duration,
        min_duration_sec,
        max_duration_sec,
        _breath_run_predicate(
            samples,
            SileroVAD.SAMPLE_RATE,
            window,
            cut_edge,
            blocked=blocked,
            levels=levels,
            band=band if cut_edge is not None else None,
            cut_sample=(
                round((crossing_sec - window_start) * SileroVAD.SAMPLE_RATE)
                if crossing_sec is not None
                else None
            ),
        ),
        search_frames=_search_frames(search_sec, window_start, frame_duration, probs.size),
        crossing_sec=crossing_sec,
        crossing_refiner=crossing_refiner,
    )


def _refine_crossing_onset(
    samples: np.ndarray,
    window_start: float,
    hit: BreathSpan | None,
    *,
    sample_rate: int,
    noise_floor_rms: float | None,
    band: LevelBand | None,
    crossing_sec: float,
    search_sec: tuple[float, float] | None,
    keep_out: Sequence[tuple[float, float]],
    max_duration_sec: float,
) -> BreathSpan | None:
    if hit is None or band is None or noise_floor_rms is None or noise_floor_rms <= 0.0:
        return None
    frame_size = max(1, round(sample_rate * _LEVEL_FRAME_SEC))
    frame_duration = frame_size / sample_rate
    levels = _frame_levels(samples, frame_size, samples.size // frame_size)
    start = max(0, math.floor((hit.start - window_start) / frame_duration + 1e-9))
    end = min(levels.size, math.ceil((hit.end - window_start) / frame_duration - 1e-9))
    lower_bound = max(window_start, search_sec[0] if search_sec else window_start)
    # The level band finds the breath's body; its quiet onset can lie below it.
    floor = min(noise_floor_rms, band.lo) * (1.0 + 1e-6)
    while start > 0 and levels[start - 1] > floor:
        if levels[start - 1] > band.hi:
            return None
        start -= 1
        if window_start + start * frame_duration <= lower_bound:
            return None
        if (end - start) * frame_duration > max_duration_sec:
            return None
    if (
        start == 0
        or window_start + start * frame_duration <= lower_bound
        or (end - start) * frame_duration > max_duration_sec
    ):
        return None
    blocked = _blocked_frames(keep_out, window_start, frame_duration, levels.size)
    accept = _breath_run_predicate(
        samples,
        sample_rate,
        frame_size,
        "start",
        blocked=blocked,
        levels=levels,
        band=LevelBand(lo=floor, hi=band.hi),
        cut_sample=round((crossing_sec - window_start) * sample_rate),
    )
    if not accept(start, end):
        return None
    return BreathSpan(window_start + start * frame_duration, hit.end, hit.side)


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
    noise_floor_rms: float | None = None,
    cut_edge: str | None = None,
    keep_out: Sequence[tuple[float, float]] = (),
    search_sec: tuple[float, float] | None = None,
    crossing_sec: float | None = None,
) -> BreathSpan | None:
    """Classify a bounded sample window using the shared breath detectors.

    Callers choose the window: a hit outside that window cannot classify it, and
    ``search_sec`` selects complete runs overlapping that interval while the rest
    of the window still informs the checks. ``crossing_sec`` locates the cut inside
    the window. Each accepted run is traced back to room tone to include a quiet
    onset, within the search window and maximum duration, before the refined span is
    tested against that boundary.
    ``cut_edge`` names the window edge that touches the cut
    being extended (``"end"`` before it, ``"start"`` after it); a hit then also
    needs unvoiced audio below the band ceiling all the way to that edge, neither
    the hit nor that stretch may touch a ``keep_out`` span (source seconds; the kept
    transcript words), and the hit may not continue a kept word on its far side
    without the level first falling to the band floor. The level band comes from
    the caller's ``speech_reference_rms`` and ``noise_floor_rms`` (see
    :func:`level_profile`); adjacent-cut classification abstains when no valid
    band can be formed. A caller with no floor measurement bounds the band by
    the speech level alone. Silero candidate-run classification can proceed
    without a level reference because it has no adjacent cut to protect.
    Both backends share this one band and predicate construction (below), so a
    Silero hit is rejected by the same gap-ceiling and kept-word-adjacency rules
    as a heuristic one. Silero is only used at its required 16 kHz rate with its
    model available.
    """
    band = None
    if speech_reference_rms is not None and np.isfinite(speech_reference_rms):
        band = breath_level_band(noise_floor_rms or 0.0, speech_reference_rms)

    if cut_edge is not None and band is None:
        return None

    def refine_crossing(hit: BreathSpan) -> BreathSpan | None:
        if crossing_sec is None:
            return hit
        return _refine_crossing_onset(
            samples,
            window_start,
            hit,
            sample_rate=sample_rate,
            noise_floor_rms=noise_floor_rms,
            band=band,
            crossing_sec=crossing_sec,
            search_sec=search_sec,
            keep_out=keep_out,
            max_duration_sec=max_duration_sec,
        )

    if vad_backend == "silero" and sample_rate == 16000:
        from podcast_mcp.engines.vad_silero import get_shared_vad

        # Model construction or inference can fail after the package check.
        try:
            vad = get_shared_vad()
            if vad is not None:
                hit = _find_breath_in_window_silero(
                    samples,
                    window_start,
                    min_duration_sec=min_duration_sec,
                    max_duration_sec=max_duration_sec,
                    vad=vad,
                    cut_edge=cut_edge,
                    keep_out=keep_out,
                    search_sec=search_sec,
                    band=band,
                    crossing_sec=crossing_sec,
                    crossing_refiner=refine_crossing if crossing_sec is not None else None,
                )
                return hit
        except Exception:
            log.debug("Silero breath inference failed; using RMS heuristic", exc_info=True)

    if band is None:
        return None
    if candidate_run:
        # A window wholly inside an acoustic run must itself sit below the speech
        # boundary before the shape scan is useful, or ordinary speech is mislabelled.
        if not samples.size or not np.all(np.isfinite(samples)):
            return None
        if float(np.sqrt(np.mean(samples**2))) > band.hi:
            return None
        # The run already passed a permissive voicing check; clear pitch anywhere
        # in it keeps the whole candidate reviewable rather than calling it breath.
        if not _is_unvoiced(samples, sample_rate, min_rms=band.lo):
            return None
    hit = _find_breath_in_window(
        samples,
        window_start,
        sample_rate=sample_rate,
        band=band,
        min_duration_sec=min_duration_sec,
        max_duration_sec=max_duration_sec,
        cut_edge=cut_edge,
        keep_out=keep_out,
        search_sec=search_sec,
        crossing_sec=crossing_sec,
        crossing_refiner=refine_crossing if crossing_sec is not None else None,
    )
    return hit


def detect_adjacent_breath(
    project,
    track_id: str,
    cut_start: float,
    cut_end: float,
    *,
    defaults: dict | None = None,
    sample_rate: int = 16000,
    audio_cache: TrackAudioCache | None = None,
    word_index: CutWordIndex | None = None,
    crossing_end_only: bool = False,
) -> list[BreathSpan]:
    """Breath-shaped runs just before and after a cut on ``track_id``'s raw audio.

    Kept transcript words (from ``word_index``, built here when the caller has
    none) are never part of a breath or of the stretch between it and the cut, and
    a run that continues one without the level falling to the band floor is that
    word's tail or onset; words the cut itself removes at least half of are not kept.
    ``crossing_end_only`` reads across the final cut end and returns only a complete
    refined breath span crossing it, so a caller can retreat to the breath's onset.
    """
    cfg = _breath_cfg(defaults)
    if not cfg["enabled"]:
        return []

    min_dur = cfg["min_duration_ms"] / 1000.0
    max_dur = cfg["max_duration_ms"] / 1000.0

    def _find(
        samples: np.ndarray,
        window_start: float,
        cut_edge: str,
        profile: tuple[float, float],
        keep_out: Sequence[tuple[float, float]],
        search_sec: tuple[float, float],
    ) -> BreathSpan | None:
        noise_floor_rms, speech_rms = profile
        return classify_breath_samples(
            samples,
            window_start,
            sample_rate=sample_rate,
            vad_backend=cfg["vad_backend"],
            defaults=defaults,
            min_duration_sec=min_dur,
            max_duration_sec=max_dur,
            speech_reference_rms=speech_rms,
            noise_floor_rms=noise_floor_rms,
            cut_edge=cut_edge,
            keep_out=keep_out,
            search_sec=search_sec,
            crossing_sec=cut_end if crossing_end_only else None,
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

    # The kept audio on both sides of the cut sets the level band; the search
    # windows are the tail and head of those same two reads, which the detector
    # scans whole so a run can be traced back to a kept word beyond the window.
    context_start = max(0.0, cut_start - _LEVEL_CONTEXT_SEC)
    before_context = _read(context_start, cut_start - context_start)
    after_context = _read(cut_end, _LEVEL_CONTEXT_SEC)
    profile = level_profile(np.concatenate([before_context, after_context]), sample_rate)
    if profile is None:
        return []
    if word_index is None:
        word_index = CutWordIndex.build(project, track_id)
    keep_out = [
        (start, end)
        for start, end in word_index.live_word_spans(context_start, cut_end + _LEVEL_CONTEXT_SEC)
        if min(end, cut_end) - max(start, cut_start) < 0.5 * (end - start)
    ]

    if crossing_end_only:
        window_start = max(0.0, cut_end - _LEVEL_CONTEXT_SEC)
        context = _read(window_start, cut_end + _LEVEL_CONTEXT_SEC - window_start)
        search = (cut_end - max_dur, cut_end + max_dur)
        hit = _find(context, window_start, "start", profile, keep_out, search)
        return [BreathSpan(start=hit.start, end=hit.end, side="crossing")] if hit else []

    spans: list[BreathSpan] = []
    before_sec = cfg["search_before_ms"] / 1000.0
    after_sec = cfg["search_after_ms"] / 1000.0

    if before_sec > min_dur:
        search = (max(context_start, cut_start - before_sec), cut_start)
        hit = _find(before_context, context_start, "end", profile, keep_out, search)
        if hit:
            spans.append(BreathSpan(start=hit.start, end=hit.end, side="before"))

    if after_sec > min_dur:
        search = (cut_end, cut_end + after_sec)
        hit = _find(after_context, cut_end, "start", profile, keep_out, search)
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
