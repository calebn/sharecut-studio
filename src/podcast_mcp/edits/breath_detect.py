from __future__ import annotations

import logging
import math
import subprocess
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Literal

import numpy as np

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.audio_cache import (
    DIGITAL_SILENCE_DB,
    LEVEL_FRAME_SEC,
    BandLevels,
    TrackAudioCache,
    level_profile,
)
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.edits.room_model import (
    MIN_ROOM_SEC,
    Room,
    Sound,
    find_sounds,
    mode_spread,
    read_room,
    smoothed,
)
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.engines.session_timeline import SessionTimeline, TimelineSourceSpan
from podcast_mcp.util.dsp import (
    bool_runs,
    db_to_amplitude,
    frame_rms_db,
    high_band_energy_fraction,
    voicing_probes,
)
from podcast_mcp.util.source_spans import source_span_timeline_bounds
from podcast_mcp.util.timebase import SourceSec, TimelineSec
from podcast_mcp.util.tracks import dialogue_track_ids, track_audio_path

if TYPE_CHECKING:
    from podcast_mcp.engines.vad_silero import SileroVAD
    from podcast_mcp.models import EpisodeProject

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
# Both are read from the kept audio flanking a cut, this much on each side
# (``level_profile``). On the lab tape breaths sit 6-39 dB below that speech level
# and 12-45 dB above that floor (#814); a fixed audibility floor put the band at
# -32.4 to -31 dBFS and found 1 of 26.
_LEVEL_CONTEXT_SEC = 5.0
_BREATH_ABOVE_FLOOR_DB = 9.5
_BREATH_BELOW_SPEECH_DB = (7.0, 40.0)
# A pause trim removes only air (#1055). Air is a track's room tone, and the line between
# room and sound is the room's own (:mod:`podcast_mcp.edits.room_model`), read from the
# track's 10 ms speech-band levels between its own words (padded) and outside the pause
# itself, which sound may fill; that window widens to 30 s when the 5 s each side holds
# under half a second of such frames.
_ROOM_WORD_PAD_SEC = 0.05
_ROOM_REACH_SEC = 30.0
# Two clocks that agree to a microsecond are the same instant (clip placements are floats).
_CLOCK_EPS_SEC = 1e-6


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
        levels = frame_rms_db(samples, frame, hop, floor_db=DIGITAL_SILENCE_DB)
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
    frame_size = max(1, int(sample_rate * LEVEL_FRAME_SEC))
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


def _connected_activity(levels: np.ndarray, floor: float) -> list[tuple[int, int]]:
    return list(bool_runs(levels > floor))


def _complete_crossing_span(
    samples: np.ndarray,
    window_start: float,
    hit: BreathSpan,
    *,
    sample_rate: int,
    noise_floor_rms: float | None,
    band: LevelBand | None,
    crossing_sec: float,
    search_sec: tuple[float, float] | None,
    keep_out: Sequence[tuple[float, float]],
    max_duration_sec: float,
) -> BreathSpan | None:
    if band is None or noise_floor_rms is None or noise_floor_rms <= 0.0:
        return None
    frame_size = max(1, round(sample_rate * LEVEL_FRAME_SEC))
    frame_duration = frame_size / sample_rate
    levels = _frame_levels(samples, frame_size, samples.size // frame_size)
    floor = min(noise_floor_rms, band.lo) * (1.0 + 1e-6)
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
    lower = max(window_start, search_sec[0] if search_sec else window_start)
    upper = min(
        window_start + levels.size * frame_duration, search_sec[1] if search_sec else math.inf
    )
    for start, end in _connected_activity(levels, floor):
        lo = (round(window_start * sample_rate) + start * frame_size) / sample_rate
        hi = (round(window_start * sample_rate) + end * frame_size) / sample_rate
        if not (lo < crossing_sec < hi and lo < hit.end and hit.start < hi):
            continue
        if start == 0 or end == levels.size or lo <= lower or hi >= upper:
            return None
        if hi - lo > max_duration_sec + 1e-9 or (levels[start:end] > band.hi).any():
            return None
        body_start = round((hit.start - window_start) * sample_rate)
        body_end = round((hit.end - window_start) * sample_rate)
        extensions = (
            samples[start * frame_size : body_start],
            samples[body_end : end * frame_size],
        )
        if any(_is_sibilant(part, sample_rate) for part in extensions) or not accept(start, end):
            return None
        return BreathSpan(lo, hi, hit.side)
    return None


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
    onset and tail, with measured floor separators inside the search window and
    maximum duration, before testing the complete span against that boundary.
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
        return _complete_crossing_span(
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
) -> list[BreathSpan]:
    """Breath-shaped runs just before and after a cut on ``track_id``'s raw audio.

    Kept transcript words (from ``word_index``, built here when the caller has
    none) are never part of a breath or of the stretch between it and the cut, and
    a run that continues one without the level falling to the band floor is that
    word's tail or onset; words the cut itself removes at least half of are not kept.
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
        )

    read = _audio_reader(project, track_id, sample_rate, audio_cache)
    if read is None:
        return []

    # The kept audio on both sides of the cut sets the level band; the search
    # windows are the tail and head of those same two reads, which the detector
    # scans whole so a run can be traced back to a kept word beyond the window.
    context_start = max(0.0, cut_start - _LEVEL_CONTEXT_SEC)
    before_context = _read_evidence(read, context_start, cut_start - context_start)
    after_context = _read_evidence(read, cut_end, _LEVEL_CONTEXT_SEC)
    profile = level_profile(np.concatenate([before_context, after_context]), sample_rate)
    if profile is None:
        return []
    word_index = word_index or CutWordIndex.build(project, track_id)
    keep_out = _kept_spans(
        word_index, context_start, cut_end + _LEVEL_CONTEXT_SEC, cut_start, cut_end
    )

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


def _audio_reader(
    project: EpisodeProject,
    track_id: str,
    sample_rate: int,
    audio_cache: TrackAudioCache | None,
) -> Callable[[float, float], np.ndarray] | None:
    if audio_cache is not None and audio_cache.waveform.sample_rate == sample_rate:
        return lambda start, duration: audio_cache.window(start, start + duration)
    try:
        path = track_audio_path(project, track_id)
    except ValueError:
        return None
    return lambda start, duration: load_mono_window(
        path, start_sec=start, duration_sec=duration, sample_rate=sample_rate
    )


def _read_evidence(
    read: Callable[[float, float], np.ndarray], start: float, duration: float
) -> np.ndarray:
    try:
        return read(start, duration)
    except (OSError, ValueError, subprocess.CalledProcessError):
        return np.empty(0)


def _kept_spans(
    words: CutWordIndex,
    lo: float,
    hi: float,
    start: float,
    end: float,
) -> list[tuple[float, float]]:
    return [
        (a, b)
        for a, b in words.live_word_spans(lo, hi)
        if min(b, end) - max(a, start) < 0.5 * (b - a)
    ]


@dataclass(frozen=True)
class _ClearEdge:
    pass


@dataclass(frozen=True)
class _CompleteEdgeBreath:
    span: BreathSpan


@dataclass(frozen=True)
class _UncertainEdge:
    reason: Literal["protected_activity", "incomplete_activity", "missing_evidence"]


def _edge_evidence(
    samples: np.ndarray,
    origin: float,
    edge: float,
    *,
    sample_rate: int,
    profile: tuple[float, float],
    cfg: dict,
    keep_out: Sequence[tuple[float, float]],
) -> _ClearEdge | _CompleteEdgeBreath | _UncertainEdge:
    band = breath_level_band(*profile)
    if band is None or not samples.size or not np.all(np.isfinite(samples)):
        return _UncertainEdge("missing_evidence")
    frame_size = max(1, round(sample_rate * LEVEL_FRAME_SEC))
    dt = frame_size / sample_rate
    levels = _frame_levels(samples, frame_size, samples.size // frame_size)
    if not origin < edge < origin + levels.size * dt:
        return _UncertainEdge("missing_evidence")
    floor = min(profile[0], band.lo) * (1.0 + 1e-6)
    max_duration = cfg["max_duration_ms"] / 1000.0
    for start, end in _connected_activity(levels, floor):
        lo = (round(origin * sample_rate) + start * frame_size) / sample_rate
        hi = (round(origin * sample_rate) + end * frame_size) / sample_rate
        if not lo < edge < hi:
            continue
        if start == 0 or end == levels.size or hi - lo > max_duration + 1e-9:
            return _UncertainEdge("incomplete_activity")
        hit = classify_breath_samples(
            samples,
            origin,
            sample_rate=sample_rate,
            vad_backend=cfg["vad_backend"],
            min_duration_sec=cfg["min_duration_ms"] / 1000.0,
            max_duration_sec=max_duration,
            speech_reference_rms=profile[1],
            noise_floor_rms=profile[0],
            cut_edge="start",
            keep_out=keep_out,
            search_sec=(edge - max_duration, edge + max_duration),
            crossing_sec=edge,
        )
        if hit is None:
            return _UncertainEdge("protected_activity")
        return _CompleteEdgeBreath(hit)
    return _ClearEdge()


def protect_cut_breaths(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    defaults: dict | None = None,
    sample_rate: int = 16000,
    audio_cache: TrackAudioCache | None = None,
    word_index: CutWordIndex | None = None,
    strict: bool = True,
) -> tuple[float, float] | None:
    """Shrink final edges around complete breaths, or suppress uncertain cuts.

    ``strict`` (a splice): missing evidence and protected connected activity are
    not clean boundaries, so either suppresses the cut. Otherwise (an edge that
    fades against fill) only a breath matters: an edge inside a complete breath
    moves out of it, keeping the breath whole, an edge with no breath found stays
    put, and a cut that is mostly breath is suppressed. A cut that a breath fills
    edge to edge is suppressed either way. A pause trim is not a cut through
    sound at all; it takes :func:`pause_air_span` instead. Disabled handling
    returns the input without reading audio. Source seconds.
    """
    if not (math.isfinite(start) and math.isfinite(end) and start < end):
        return None
    cfg = _breath_cfg(defaults)
    if not cfg["enabled"]:
        return start, end
    no_evidence = None if strict else (start, end)
    read = _audio_reader(project, track_id, sample_rate, audio_cache)
    if read is None:
        return no_evidence
    context_start = max(
        0.0, math.floor((start - _LEVEL_CONTEXT_SEC) / LEVEL_FRAME_SEC + 1e-9) * LEVEL_FRAME_SEC
    )
    before_end = math.floor(start / LEVEL_FRAME_SEC + 1e-9) * LEVEL_FRAME_SEC
    after_start = math.ceil(end / LEVEL_FRAME_SEC - 1e-9) * LEVEL_FRAME_SEC
    before = _read_evidence(read, context_start, before_end - context_start)
    after = _read_evidence(read, after_start, _LEVEL_CONTEXT_SEC)
    context = np.concatenate([before, after])
    if not np.all(np.isfinite(context)):
        return no_evidence
    profile = level_profile(context, sample_rate)
    if profile is None:
        return no_evidence
    words = word_index or CutWordIndex.build(project, track_id)
    windows = []
    for edge in (start, end):
        origin = max(
            0.0,
            math.floor((edge - _LEVEL_CONTEXT_SEC) / LEVEL_FRAME_SEC + 1e-9) * LEVEL_FRAME_SEC,
        )
        samples = _read_evidence(read, origin, edge + _LEVEL_CONTEXT_SEC - origin)
        windows.append((origin, samples))

    def inspect(
        edge: float, window: tuple[float, np.ndarray], bounds: tuple[float, float]
    ) -> _ClearEdge | _CompleteEdgeBreath | _UncertainEdge:
        origin, samples = window
        keep_out = _kept_spans(words, origin, origin + samples.size / sample_rate, *bounds)
        return _edge_evidence(
            samples,
            origin,
            edge,
            sample_rate=sample_rate,
            profile=profile,
            cfg=cfg,
            keep_out=keep_out,
        )

    evidence = [
        inspect(edge, window, (start, end))
        for edge, window in zip((start, end), windows, strict=True)
    ]
    if strict and any(isinstance(item, _UncertainEdge) for item in evidence):
        return None
    new_start = evidence[0].span.end if isinstance(evidence[0], _CompleteEdgeBreath) else start
    new_end = evidence[1].span.start if isinstance(evidence[1], _CompleteEdgeBreath) else end
    if new_start >= new_end:
        return None
    if strict:
        for edge, window in zip((start, end), windows, strict=True):
            if isinstance(inspect(edge, window, (new_start, new_end)), _UncertainEdge):
                return None
    elif _mostly_breath(
        new_start,
        new_end,
        read=read,
        words=words,
        profile=profile,
        cfg=cfg,
        sample_rate=sample_rate,
    ):
        # Keeping breaths whole also means not removing one that is most of the cut.
        return None
    return new_start, new_end


class PauseAirSkip(Enum):
    """Why :func:`pause_air_span` has no span to give."""

    NO_AIR = "no_air"
    NO_ROOM = "no_room"


@dataclass(frozen=True)
class PauseAir:
    """The stretch of a pause a trim may take.

    ``start`` and ``end`` are the trim track's source seconds. ``kept`` are the sounds
    on any track the ripple cuts that must stay whole (they reach within 40 dB of their
    track's speech level), in session seconds: a shared-pause twin that holds one of
    them does not protect what this trim does.
    """

    start: float
    end: float
    kept: tuple[tuple[float, float], ...] = ()

    @property
    def span(self) -> tuple[float, float]:
        return self.start, self.end


@dataclass(frozen=True)
class _TrackView:
    """One track's speech-band levels around a pause (from the grid point ``origin``)."""

    levels: np.ndarray
    room: Room | None
    speech_db: float | None


def _band_source(
    project: EpisodeProject, track_id: str, sample_rate: int, audio_cache: TrackAudioCache | None
) -> BandLevels | None:
    """The speech-band levels of ``track_id``: the run's shared ones, else its own reads."""
    if audio_cache is not None and int(audio_cache.waveform.sample_rate) == sample_rate:
        return audio_cache.band_levels
    read = _audio_reader(project, track_id, sample_rate, None)
    if read is None:
        return None
    track = project.track_by_id(track_id)
    duration = track.media.duration_sec if track is not None and track.media is not None else None
    return BandLevels(read, sample_rate, duration or 0.0)


def _frame_origin(t: float) -> float:
    """The 10 ms grid point at or before ``t`` (never before the start of the file)."""
    return max(0.0, math.floor(t / LEVEL_FRAME_SEC + 1e-9) * LEVEL_FRAME_SEC)


def _track_view(
    bands: BandLevels,
    words: CutWordIndex,
    pause: tuple[float, float],
    origin: float,
    sample_rate: int,
) -> _TrackView | None:
    """One track around a pause: its levels from ``origin`` to 5 s past the pause, its room
    and its speech level; ``None`` when the audio cannot be read.

    The room is read from the frames between the track's own words (padded) and outside
    the pause, which sound may fill. A window with under half a second of such frames is
    too crowded to read a room from (a fluent speaker, words abutting), so the wider
    window is tried before the room is given up (``None``). Digital silence between
    words counts as the level it is.
    """
    dt = LEVEL_FRAME_SEC
    wide_origin = _frame_origin(pause[0] - _ROOM_REACH_SEC)
    wide = bands.levels(wide_origin, pause[1] + _ROOM_REACH_SEC)
    if wide is None:
        return None
    first = round((origin - wide_origin) / dt)
    levels = wide[first : first + math.ceil((pause[1] + _LEVEL_CONTEXT_SEC - origin) / dt - 1e-9)]
    speech_db = bands.speech_db()
    spans = words.live_word_spans(wide_origin, wide_origin + wide.size * dt)
    padded = [(a - _ROOM_WORD_PAD_SEC, b + _ROOM_WORD_PAD_SEC) for a, b in spans]
    between = ~_blocked_frames([*padded, pause], wide_origin, dt, wide.size)
    smooth = smoothed(wide)
    ceiling = math.inf if speech_db is None else speech_db - _BREATH_BELOW_SPEECH_DB[1]
    prior = mode_spread(smooth, ceiling, sample_rate)
    for lo, hi in ((first, first + levels.size), (0, wide.size)):
        if np.count_nonzero(between[lo:hi]) * dt >= MIN_ROOM_SEC:
            room = read_room(smooth[lo:hi][between[lo:hi]], sample_rate, prior)
            return _TrackView(levels, room, speech_db)
    return _TrackView(levels, None, speech_db)


def _off_sounds(lo: int, hi: int, sounds: Sequence[tuple[int, int]]) -> tuple[int, int]:
    """``[lo, hi)`` with each edge moved off any of ``sounds`` it sits inside.

    An edge one sound moves can land in another, so they move together until settled.
    """
    moved = True
    while moved and lo < hi:
        moved = False
        for sound_lo, sound_hi in sounds:
            if sound_lo < lo < sound_hi:
                lo, moved = sound_hi, True
            if sound_lo < hi < sound_hi:
                hi, moved = sound_lo, True
    return lo, hi


@dataclass(frozen=True)
class _TrackSounds:
    """The sounds on one track around a pause, as frame ranges counted from ``origin`` (a
    source second), and how many frames of the track's audio the read covers."""

    origin: float
    frames: int
    sounds: list[Sound]


def _track_sounds(
    project: EpisodeProject,
    track_id: str,
    pause: tuple[float, float],
    *,
    sample_rate: int,
    audio_cache: TrackAudioCache | None,
    words: CutWordIndex,
    require_speech: bool = False,
) -> _TrackSounds | PauseAirSkip | None:
    """The sounds of ``track_id`` around ``pause`` (its source seconds).

    ``None`` when the track has no audio there (its recording ends before the pause).
    :attr:`PauseAirSkip.NO_ROOM` when the audio cannot be read or its room cannot be
    measured: a track that cannot be read cannot be checked, and an edge on it would go
    unchecked. ``require_speech`` also asks for a speech level, and for audio at the pause.
    """
    dt = LEVEL_FRAME_SEC
    bands = _band_source(project, track_id, sample_rate, audio_cache)
    origin = _frame_origin(pause[0] - _LEVEL_CONTEXT_SEC)
    view = None if bands is None else _track_view(bands, words, pause, origin, sample_rate)
    if view is None:
        return PauseAirSkip.NO_ROOM
    gap_lo = math.floor((pause[0] - origin) / dt + 1e-9)
    if view.levels.size <= gap_lo:
        return PauseAirSkip.NO_ROOM if require_speech else None
    if view.room is None or (require_speech and view.speech_db is None):
        return PauseAirSkip.NO_ROOM
    gap = (gap_lo, min(view.levels.size, math.ceil((pause[1] - origin) / dt - 1e-9)))
    sounds = find_sounds(
        view.levels,
        view.room,
        view.speech_db,
        gap,
        sample_rate,
        breath_below_speech_db=_BREATH_BELOW_SPEECH_DB,
    )
    return _TrackSounds(origin, view.levels.size, sounds)


def _contiguous_pieces(
    timeline: SessionTimeline, track_id: str, window: tuple[float, float]
) -> list[TimelineSourceSpan]:
    """The stretches of ``track_id``'s lane under the session ``window``, each unbroken in
    both clocks (clips that abut in the lane and in the source are one), gaps left out."""
    pieces: list[TimelineSourceSpan] = []
    for span in timeline.map_timeline_spans(
        track_id, TimelineSec(window[0]), TimelineSec(window[1])
    ):
        last = pieces[-1] if pieces else None
        if (
            last is not None
            and abs(float(last.timeline_end) - float(span.timeline_start)) < _CLOCK_EPS_SEC
            and abs(float(last.source_end) - float(span.source_start)) < _CLOCK_EPS_SEC
        ):
            pieces[-1] = TimelineSourceSpan(
                timeline_start=last.timeline_start,
                timeline_end=span.timeline_end,
                source_start=last.source_start,
                source_end=span.source_end,
            )
        else:
            pieces.append(span)
    return pieces


def _peer_sounds_on_session_clock(
    project: EpisodeProject,
    timeline: SessionTimeline,
    track_id: str,
    window: tuple[float, float],
    *,
    sample_rate: int,
    audio_cache: TrackAudioCache | None,
    words: CutWordIndex,
) -> list[tuple[float, float, bool]] | PauseAirSkip:
    """A peer's sounds under the session ``window``, as ``(start, end, removable)`` in
    session seconds.

    A session ripple removes session time, which is a different stretch of each track's
    source wherever its recording sits on the timeline, so the peer is read through its
    own clips: every stretch of its lane under the window, at the source seconds that
    back it. A stretch of the window where the peer's lane holds no clip has no audio, so
    it contributes no sound. A sound the lane's clip boundary cuts reaches one frame past
    the boundary, so an edge at the join is inside it, not beside it.
    """
    dt = LEVEL_FRAME_SEC
    out: list[tuple[float, float, bool]] = []
    for piece in _contiguous_pieces(timeline, track_id, window):
        src_lo, src_hi = float(piece.source_start), float(piece.source_end)
        got = _track_sounds(
            project,
            track_id,
            (src_lo, src_hi),
            sample_rate=sample_rate,
            audio_cache=audio_cache,
            words=words,
        )
        if isinstance(got, PauseAirSkip):
            return got
        if got is None:
            continue
        shift = float(piece.timeline_start) - src_lo
        lane = (float(piece.timeline_start), float(piece.timeline_end))
        for sound in got.sounds:
            lo = got.origin + sound.lo * dt + shift
            hi = got.origin + sound.hi * dt + shift
            if min(hi, lane[1]) <= max(lo, lane[0]):
                continue
            cut_lo, cut_hi = lo < lane[0] - _CLOCK_EPS_SEC, hi > lane[1] + _CLOCK_EPS_SEC
            out.append(
                (
                    lane[0] - dt if cut_lo else lo,
                    lane[1] + dt if cut_hi else hi,
                    sound.removable,
                )
            )
    return out


def _session_spans(
    timeline: SessionTimeline, track_id: str, origin: float, lo: int, hi: int
) -> list[tuple[float, float]]:
    """Frames ``[lo, hi)`` counted from ``origin`` on ``track_id``'s source clock, on the
    session's."""
    dt = LEVEL_FRAME_SEC
    mapped = timeline.map_source_span(
        track_id, SourceSec(origin + lo * dt), SourceSec(origin + hi * dt)
    )
    return [(float(a), float(b)) for a, b in mapped]


def pause_air_span(
    project: EpisodeProject,
    track_id: str,
    start: float,
    end: float,
    *,
    pause: tuple[float, float],
    defaults: dict | None = None,
    sample_rate: int = 16000,
    audio_cache: TrackAudioCache | None = None,
    audio_caches: Mapping[str, TrackAudioCache] | None = None,
    word_indexes: Mapping[str, CutWordIndex] | None = None,
) -> PauseAir | PauseAirSkip:
    """The longest stretch of air in ``[start, end)``, or why there is none.

    ``pause`` is the span the trim may take (the word gap less the retained air). A
    session ripple removes the same window of session time from every dialogue track, so
    the trim is judged by one rule on all of them, the trim's own included: each track's
    levels are read in the speech band around the pause, and its room, the line between
    room and sound, and its speech level all come from the track's own levels
    (:mod:`podcast_mcp.edits.room_model`). No edge sits inside a sound. A sound that
    reaches 40 dB under its track's speech level stays whole and splits the air, and a
    quieter one is removed whole when the span holds all of it or kept whole when it
    crosses an edge. The same stretch asked for on another track gets the same answer.

    Peers are read where the ripple removes them: through their own clips, at the source
    seconds each backs under the trim's session window, not at the trim track's seconds.
    A peer with no clip under part of the window has no audio there. A track whose room
    cannot be measured (audio that cannot be read, or under half a second of frames
    between its words even after the window widens) gives :attr:`PauseAirSkip.NO_ROOM`,
    the trim's own or a peer's, because an edge on it could not be checked; so does the
    trim's own track when it has no speech level. A trim with nothing left gives
    :attr:`PauseAirSkip.NO_AIR`. ``word_indexes`` are the tracks' word indexes, built once
    per proposal run. Disabled handling returns the input without reading audio. Source
    seconds.
    """
    if not (math.isfinite(start) and math.isfinite(end) and start < end):
        return PauseAirSkip.NO_AIR
    if not _breath_cfg(defaults)["enabled"]:
        return PauseAir(start, end)
    dt = LEVEL_FRAME_SEC
    timeline = SessionTimeline(project)
    # The edit checks can leave the span a little outside the pause; the peers are read under both.
    window = source_span_timeline_bounds(
        timeline, track_id, min(pause[0], start), max(pause[1], end)
    )
    if window[0] is None or window[1] is None:
        return PauseAirSkip.NO_AIR
    caches = audio_caches or {}
    indexes = word_indexes or {}

    def words(tid: str) -> CutWordIndex:
        return indexes.get(tid) or CutWordIndex.build(project, tid)

    own = _track_sounds(
        project,
        track_id,
        pause,
        sample_rate=sample_rate,
        audio_cache=audio_cache,
        words=words(track_id),
        require_speech=True,
    )
    if own is None or isinstance(own, PauseAirSkip):
        return PauseAirSkip.NO_ROOM
    # Sounds no edge may sit in that may still lie whole inside the span (the removable
    # ones), and those that split the air. Frame ranges count from the trim track's
    # ``origin``; ``kept`` is the splitting sounds on the session clock.
    splits: list[tuple[int, int]] = []
    whole: list[tuple[int, int]] = []
    kept: list[tuple[float, float]] = []
    for sound in own.sounds:
        if sound.removable:
            whole.append((sound.lo, sound.hi))
        else:
            splits.append((sound.lo, sound.hi))
            kept.extend(_session_spans(timeline, track_id, own.origin, sound.lo, sound.hi))
    for tid in dialogue_track_ids(project):
        if tid == track_id:
            continue
        peer = _peer_sounds_on_session_clock(
            project,
            timeline,
            tid,
            (float(window[0]), float(window[1])),
            sample_rate=sample_rate,
            audio_cache=caches.get(tid),
            words=words(tid),
        )
        if isinstance(peer, PauseAirSkip):
            return peer
        for lo_tl, hi_tl, removable in peer:
            if not removable:
                kept.append((lo_tl, hi_tl))
            for lo_src, hi_src in timeline.map_timeline_span(
                track_id, TimelineSec(lo_tl), TimelineSec(hi_tl)
            ):
                frames = (
                    math.floor((float(lo_src) - own.origin) / dt + 1e-9),
                    math.ceil((float(hi_src) - own.origin) / dt - 1e-9),
                )
                (whole if removable else splits).append(frames)
    first = max(0, math.floor((start - own.origin) / dt + 1e-9))
    last = min(own.frames, math.ceil((end - own.origin) / dt - 1e-9))
    keep = np.zeros(max(last, 0), dtype=bool)
    for lo, hi in splits:
        keep[max(lo, 0) : max(min(hi, last), 0)] = True
    best: tuple[int, int] | None = None
    for lo, hi in bool_runs(~keep[first:last]):
        lo, hi = _off_sounds(first + lo, first + hi, whole)
        if lo < hi and (best is None or hi - lo > best[1] - best[0]):
            best = (lo, hi)
    if best is None:
        return PauseAirSkip.NO_AIR
    frame = max(1, round(sample_rate * dt))
    at = round(own.origin * sample_rate)
    lo_sec = (at + best[0] * frame) / sample_rate
    hi_sec = (at + best[1] * frame) / sample_rate
    # An ASR word end sits on the frame grid; its own frame boundary is the same edge.
    return PauseAir(
        start if abs(lo_sec - start) < 1e-6 else max(start, lo_sec),
        end if abs(hi_sec - end) < 1e-6 else min(end, hi_sec),
        tuple(kept),
    )


def _mostly_breath(
    start: float,
    end: float,
    *,
    read: Callable[[float, float], np.ndarray],
    words: CutWordIndex,
    profile: tuple[float, float],
    cfg: dict,
    sample_rate: int,
) -> bool:
    """Whether a breath covers at least half of ``[start, end)``.

    The breath run inside the span counts, and so does a complete breath traced to
    room tone. Any span covering half of the cut contains its midpoint, so the edge
    evidence at the midpoint finds the complete breath.
    """
    mid = (start + end) / 2
    origin = max(
        0.0, math.floor((mid - _LEVEL_CONTEXT_SEC) / LEVEL_FRAME_SEC + 1e-9) * LEVEL_FRAME_SEC
    )
    samples = _read_evidence(read, origin, mid + _LEVEL_CONTEXT_SEC - origin)
    if not samples.size or not np.all(np.isfinite(samples)):
        return False
    keep_out = _kept_spans(words, origin, origin + samples.size / sample_rate, start, end)
    evidence = _edge_evidence(
        samples,
        origin,
        mid,
        sample_rate=sample_rate,
        profile=profile,
        cfg=cfg,
        keep_out=keep_out,
    )
    if isinstance(evidence, _CompleteEdgeBreath):
        breath: BreathSpan | None = evidence.span
    else:
        breath = classify_breath_samples(
            samples,
            origin,
            sample_rate=sample_rate,
            vad_backend=cfg["vad_backend"],
            min_duration_sec=cfg["min_duration_ms"] / 1000.0,
            max_duration_sec=cfg["max_duration_ms"] / 1000.0,
            speech_reference_rms=profile[1],
            noise_floor_rms=profile[0],
            keep_out=keep_out,
            search_sec=(start, end),
        )
    if breath is None:
        return False
    return min(breath.end, end) - max(breath.start, start) >= (end - start) / 2


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
