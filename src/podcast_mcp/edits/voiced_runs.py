"""Voiced speech runs in one track's decoded source audio.

Tighten proposals need one measurement in two places (#815, #818): does a cut edge
sit inside the voice of a word that stays, and does a pause span hold speech the
transcript missed. Both read the same runs: 20 ms level frames every 10 ms at or
above a floor, bridged across dips shorter than a stop closure, kept
only when enough frames carry a clear speech-pitch autocorrelation peak (so breaths,
clicks and room tone never form a run).

``edits.join_speech`` measures the same phenomenon at existing clip splices with a
floor relative to the window's loud frames. Proposal spans can be many seconds of
dead air with no loud frame to anchor to, so the caller passes the track's own
voice floor (``LevelProfile.voice_floor_db``).
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np

from podcast_mcp.engines.audio_audit import TrackRmsCache
from podcast_mcp.util.dsp import (
    bool_runs,
    bridge_short_dips,
    frame_rms_db,
    valley_basins,
    voicing_pitch_probes,
    voicing_probes,
)

VoicedRun = tuple[float, float]
"""Half-open ``(start, end)`` in source seconds, quantized to the 10 ms frame grid."""

FRAME_SEC = 0.02
HOP_SEC = 0.01
PROBE_SEC = 0.04
_BRIDGE_SEC = 0.03
_F0_MIN_HZ = 70.0
_F0_MAX_HZ = 350.0
# ``breath_detect._CLEAR_PITCH_PEAK``: the normalized autocorrelation a breath stays under.
VOICED_PEAK = 0.55
_QUIET_VOICED_PEAK = 0.28
_QUIET_F0_IQR_REL = 0.1
_QUIET_F0_IQR_MIN_HZ = 20.0
_MIN_VOICED_FRAMES = 3
# Any dip this deep on both sides, at any level, is a break a listener hears: between two
# words ("did" and the repeated "that." at lab 1020.30 are 14 dB apart), or between two
# syllables of one word. It does not say which, so a caller that needs the difference
# adds a test of its own (the span before the dip is one hum, ``is_one_hum``). With
# Whisper times the repeat at 752.72-752.90 never dips more than 6 dB inside the voice
# of "well,". A level ripples a few dB inside one sound. The depth is a dB difference,
# so it reads the same at every recording level.
HEARD_APART_DEPTH_DB = 10.0


def audible_runs(
    audio: TrackRmsCache,
    start: float,
    end: float,
    *,
    floor_db: float,
    split_at_valleys: bool = False,
) -> list[VoicedRun]:
    """Runs of frames at or above ``floor_db`` inside ``[start, end)``, voiced or not.

    ``split_at_valleys`` ends a run in a valley :data:`HEARD_APART_DEPTH_DB` deep on both
    sides, even over the floor (the valley's basin is in neither run, see
    :func:`~podcast_mcp.util.dsp.valley_basins`): the sound before it and the sound
    after it are two runs (#1358).

    Frames start on the absolute 10 ms grid, so a run's bounds depend only on the
    audio, not on the window the caller asked for. A run edge is exact to one frame:
    the level surely holds over ``(run.start + FRAME_SEC, run.end - FRAME_SEC)`` and
    surely drops outside ``[run.start, run.end]``. Dips shorter than a stop closure
    do not end a run.
    """
    sr = int(audio.sample_rate)
    frame = max(1, round(sr * FRAME_SEC))
    hop = max(1, round(sr * HOP_SEC))
    t0 = math.floor(max(0.0, start) / HOP_SEC) * HOP_SEC
    levels = frame_rms_db(audio.window(t0, end), frame, hop)
    if levels.size == 0:
        return []
    active = bridge_short_dips(levels >= floor_db, max(1, round(_BRIDGE_SEC / HOP_SEC)))
    if split_at_valleys:
        active &= ~valley_basins(levels, HEARD_APART_DEPTH_DB)
    return [(t0 + i * hop / sr, t0 + ((j - 1) * hop + frame) / sr) for i, j in bool_runs(active)]


def carries_quiet_speech_pitch(
    samples: np.ndarray, sample_rate: int, *, interior: bool = True
) -> bool | None:
    """Whether ``samples`` carry speech pitch too quiet for :func:`carries_speech_pitch`.

    Room hum can flicker weak autocorrelation peaks with scattered f0; voiced remarks keep a
    tight f0 band. ``None`` when the span is too short to score three probes.
    """
    f0_all, probes = voicing_pitch_probes(
        samples,
        sample_rate,
        probe_sec=PROBE_SEC,
        hop_sec=HOP_SEC,
        fmin=_F0_MIN_HZ,
        fmax=_F0_MAX_HZ,
        interior=interior,
    )
    full_probes = samples.size >= max(1, round(sample_rate * PROBE_SEC))
    f0_hz = f0_all[probes >= _QUIET_VOICED_PEAK] if full_probes else f0_all[:0]
    if len(f0_hz) < _MIN_VOICED_FRAMES:
        return False if probes.size >= _MIN_VOICED_FRAMES else None
    median = float(np.median(f0_hz))
    iqr = float(np.percentile(f0_hz, 75) - np.percentile(f0_hz, 25))
    cap = max(_QUIET_F0_IQR_MIN_HZ, median * _QUIET_F0_IQR_REL)
    return iqr <= cap


def carries_speech_pitch(
    samples: np.ndarray, sample_rate: int, *, interior: bool = False
) -> bool | None:
    """Whether ``samples`` carry speech pitch: a clear peak in at least three probes.

    ``None`` when they are too short for three probes, so nothing can be said either way.
    Level-free, so it reads the same at any recording gain. ``interior`` counts only a true
    autocorrelation peak (see :func:`~podcast_mcp.util.dsp.autocorr_peak`), so low-frequency
    room noise is not taken for a voice.
    """
    probes = voicing_probes(
        samples,
        sample_rate,
        probe_sec=PROBE_SEC,
        hop_sec=HOP_SEC,
        fmin=_F0_MIN_HZ,
        fmax=_F0_MAX_HZ,
        interior=interior,
    )
    if int(np.count_nonzero(probes >= VOICED_PEAK)) >= _MIN_VOICED_FRAMES:
        return True
    return False if probes.size >= _MIN_VOICED_FRAMES else None


def voiced_runs(
    audio: TrackRmsCache,
    start: float,
    end: float,
    *,
    floor_db: float,
    split_at_valleys: bool = False,
) -> list[VoicedRun]:
    """The :func:`audible_runs` that carry a clear speech-pitch peak in three probes."""
    sr = int(audio.sample_rate)
    return [
        run
        for run in audible_runs(
            audio, start, end, floor_db=floor_db, split_at_valleys=split_at_valleys
        )
        if carries_speech_pitch(audio.window(*run), sr)
    ]


def run_straddling(runs: Sequence[VoicedRun], t: float) -> VoicedRun | None:
    """The run that surely holds voice on both sides of ``t``, if any."""
    return next((r for r in runs if r[0] + FRAME_SEC < t < r[1] - FRAME_SEC), None)


def voiced_sec_inside(runs: Sequence[VoicedRun], start: float, end: float) -> float:
    """Longest stretch of one voiced run that lies inside ``[start, end]``."""
    return max((max(0.0, min(r[1], end) - max(r[0], start)) for r in runs), default=0.0)
