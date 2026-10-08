from __future__ import annotations

import logging
import math
import subprocess
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

import numpy as np

from podcast_mcp.config import load_defaults
from podcast_mcp.edits.audio_cache import (
    DIGITAL_SILENCE_DB,
    LEVEL_FRAME_SEC,
    TrackAudioCache,
    level_profile,
    room_floor_db,
)
from podcast_mcp.edits.inaudible_cuts import CutWordIndex
from podcast_mcp.engines.align import load_mono_window
from podcast_mcp.util.dsp import (
    bool_runs,
    bridge_short_dips,
    db_to_amplitude,
    frame_rms_db,
    frame_speech_band_db,
    high_band_energy_fraction,
    voicing_probes,
)
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
# A pause trim removes only air (#1055), and air is a track's room tone: its levels where
# it is not sounding, read in the speech band (``speech_band``: the render clears the
# rumble below 80 Hz, and a 40 Hz rumble can sit 10 dB over a room's broadband air, hiding
# every breath and fade that rides on it). The room of a track is read from its 10 ms
# frames between its own words (``room_floor_db``, the measure the voice walks share), over
# the 5 s each side of the pause and never over the pause itself, which sound may fill. The
# pause's quiet is the 20th percentile of its frames, digital silence included, held to that
# room: a pause that is mostly the track's own breath, or a peer's, has a 20th percentile
# inside that sound, which would read as the quiet and hide it. A sound is a run more than
# 3 dB over the quiet, which is twice the room's power: past that a frame is no longer the
# room. Dips of up to 50 ms are bridged (a breath's or a voiced decay's level flutters for
# a frame or two, and creaky voice pulses as slowly as about 20 times a second), and the
# run peaks at least 10 dB over the quiet. No trim edge may sit inside a sound, so each
# sound carries one guard frame on either side.
_PAUSE_QUIET_PERCENTILE = 20.0
_PAUSE_ROOM_PERCENTILE = 5.0
_ROOM_WORD_PAD_SEC = 0.05
_MIN_ROOM_SEC = 0.5
_SOUND_OVER_QUIET_DB = 3.0
_SOUND_PEAK_OVER_QUIET_DB = 10.0
_SOUND_DIP_SEC = 0.05
_SOUND_GUARD_FRAMES = 1


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


@dataclass(frozen=True)
class _Sound:
    """A sound on one track's 10 ms frame grid, guard frames included.

    ``removable``: it peaks under 40 dB below that track's speech level, so a pause
    trim may remove it whole. Any sound may only be removed whole or kept whole.
    """

    lo: int
    hi: int
    removable: bool


def _sounds(
    levels: np.ndarray, gap: tuple[int, int], speech_db: float | None, room_db: float | None
) -> list[_Sound]:
    """The sounds in ``levels``, against the quiet of the frames in ``gap``.

    The quiet is the gap's 20th percentile held to ``room_db``. With no
    room (a track that sounds between every word of the window) or no speech level (a
    peer with under 0.5 s of live audio nearby) every sound is kept whole. A track
    that speaks, with a room within 40 dB of its speech level, cannot tell air from
    sound in the gap, so the whole gap is one sound to keep. A track that never speaks
    nearby (a second mic that carries only its room tone) has no speech to protect:
    its room tone is air. Digital silence is never a sound.
    """
    if room_db is None:
        return [_Sound(0, levels.size, False)]
    quiet = min(float(np.percentile(levels[gap[0] : gap[1]], _PAUSE_QUIET_PERCENTILE)), room_db)
    ceiling = -math.inf if speech_db is None else speech_db - _BREATH_BELOW_SPEECH_DB[1]
    speaks = speech_db is not None and speech_db - room_db >= _SOUND_PEAK_OVER_QUIET_DB
    if quiet > DIGITAL_SILENCE_DB and speaks and quiet >= ceiling:
        return [_Sound(0, levels.size, False)]
    above = bridge_short_dips(
        levels > quiet + _SOUND_OVER_QUIET_DB, round(_SOUND_DIP_SEC / LEVEL_FRAME_SEC)
    )
    sounds: list[_Sound] = []
    for lo, hi in bool_runs(above):
        peak = float(levels[lo:hi].max())
        if peak < quiet + _SOUND_PEAK_OVER_QUIET_DB:
            continue
        lo, hi = max(0, lo - _SOUND_GUARD_FRAMES), min(levels.size, hi + _SOUND_GUARD_FRAMES)
        removable = peak < ceiling
        if sounds and lo <= sounds[-1].hi:
            sounds[-1] = _Sound(sounds[-1].lo, hi, sounds[-1].removable and removable)
        else:
            sounds.append(_Sound(lo, hi, removable))
    return sounds


def _track_room_db(
    project: EpisodeProject,
    tid: str,
    levels: np.ndarray,
    *,
    origin: float,
    gap: tuple[int, int],
) -> float | None:
    """The room of track ``tid`` around a pause: its levels between its own words.

    Frames within a word's span (padded) and the pause's own frames are left out, so
    sound that fills the pause cannot set the room it is judged against. A window with
    under half a second of such frames has no room: the track sounds all through it.
    """
    dt = LEVEL_FRAME_SEC
    words = CutWordIndex.build(project, tid).live_word_spans(origin, origin + levels.size * dt)
    padded = [(a - _ROOM_WORD_PAD_SEC, b + _ROOM_WORD_PAD_SEC) for a, b in words]
    between = ~_blocked_frames(padded, origin, dt, levels.size)
    between[gap[0] : gap[1]] = False
    if np.count_nonzero(between) * dt < _MIN_ROOM_SEC:
        return None
    return room_floor_db(levels, among=between, percentile=_PAUSE_ROOM_PERCENTILE)


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
) -> tuple[float, float] | None:
    """The longest stretch of air in ``[start, end)``, or ``None`` when none is left.

    ``pause`` is the span the trim may take (the word gap less the retained air); the
    quiet of each track is measured on it, and the 5 s on each side supply only the
    track's speech level. No edge
    sits inside a sound. On the trim's own track a sound that reaches 40 dB under the
    speech level is kept whole and splits the air, and a quieter one is removed whole
    when the span holds all of it or kept whole when it crosses an edge. A session
    ripple removes the same window from every dialogue track, so a peer's sound that
    crosses an edge moves that edge off it too, and a peer's sound that covers what is
    left leaves no air; a peer's sound inside the span is the speech guard's and the
    interior checks' to judge. A track whose audio cannot be read is skipped, unless
    it is the trim's own, which drops the trim. Disabled handling returns the input
    without reading audio. Source seconds.
    """
    if not (math.isfinite(start) and math.isfinite(end) and start < end):
        return None
    if not _breath_cfg(defaults)["enabled"]:
        return start, end
    dt = LEVEL_FRAME_SEC
    frame = max(1, round(sample_rate * dt))
    origin = max(0.0, math.floor((pause[0] - _LEVEL_CONTEXT_SEC) / dt + 1e-9) * dt)
    duration = pause[1] + _LEVEL_CONTEXT_SEC - origin
    gap = (
        max(0, math.floor((pause[0] - origin) / dt + 1e-9)),
        math.ceil((pause[1] - origin) / dt - 1e-9),
    )
    first = max(0, math.floor((start - origin) / dt + 1e-9))
    last = math.ceil((end - origin) / dt - 1e-9)
    keep = np.zeros(last, dtype=bool)
    # Sounds no edge may sit in, that may still lie whole inside the span: the own
    # track's quiet ones and every peer sound.
    whole: list[tuple[int, int]] = []
    caches = audio_caches or {}
    peers = [tid for tid in dialogue_track_ids(project) if tid != track_id]
    for tid in (track_id, *peers):
        own = tid == track_id
        read = _audio_reader(project, tid, sample_rate, audio_cache if own else caches.get(tid))
        samples = _read_evidence(read, origin, duration) if read is not None else np.empty(0)
        levels = frame_speech_band_db(samples, sample_rate, frame, floor_db=DIGITAL_SILENCE_DB)
        if not samples.size or not np.all(np.isfinite(samples)) or levels.size <= gap[0]:
            if own:
                return None
            continue
        profile = level_profile(samples, sample_rate)
        if own:
            if profile is None:
                return None
            last = min(last, levels.size)
        speech_db = None if profile is None else 20.0 * math.log10(profile[1])
        gap_frames = (gap[0], min(gap[1], levels.size))
        room_db = _track_room_db(project, tid, levels, origin=origin, gap=gap_frames)
        for sound in _sounds(levels, gap_frames, speech_db, room_db):
            if own and not sound.removable:
                keep[sound.lo : min(sound.hi, last)] = True
            else:
                whole.append((sound.lo, sound.hi))
    best: tuple[int, int] | None = None
    for lo, hi in bool_runs(~keep[first:last]):
        lo, hi = _off_sounds(first + lo, first + hi, whole)
        if lo < hi and (best is None or hi - lo > best[1] - best[0]):
            best = (lo, hi)
    if best is None:
        return None
    at = round(origin * sample_rate)
    lo_sec = (at + best[0] * frame) / sample_rate
    hi_sec = (at + best[1] * frame) / sample_rate
    # An ASR word end sits on the frame grid; its own frame boundary is the same edge.
    return (
        start if abs(lo_sec - start) < 1e-6 else max(start, lo_sec),
        end if abs(hi_sec - end) < 1e-6 else min(end, hi_sec),
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
