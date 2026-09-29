"""Voiced speech runs in one track's decoded source audio.

Tighten proposals need one measurement in two places (#815, #818): does a cut edge
sit inside the voice of a word that stays, and does a pause span hold speech the
transcript missed. Both read the same runs: 20 ms level frames every 10 ms at or
above an audibility floor, bridged across dips shorter than a stop closure, kept
only when enough frames carry a clear speech-pitch autocorrelation peak (so breaths,
clicks and room tone never form a run).

``edits.join_speech`` measures the same phenomenon at existing clip splices with a
floor relative to the window's loud frames. Proposal spans can be many seconds of
dead air with no loud frame to anchor to, so this floor is absolute (the caller
passes ``analysis.heuristics.audibility_rms_db``).
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np

from podcast_mcp.edits.audio_cache import TrackAudioCache
from podcast_mcp.util.dsp import bool_runs, bridge_short_dips, frame_rms_db, voicing_probes

VoicedRun = tuple[float, float]
"""Half-open ``(start, end)`` in source seconds, quantized to the 10 ms frame grid."""

FRAME_SEC = 0.02
HOP_SEC = 0.01
_PROBE_SEC = 0.04
_BRIDGE_SEC = 0.03
_F0_MIN_HZ = 70.0
_F0_MAX_HZ = 350.0
# ``breath_detect._CLEAR_PITCH_PEAK``: the normalized autocorrelation a breath stays under.
VOICED_PEAK = 0.55
_MIN_VOICED_FRAMES = 3


def voiced_runs(
    cache: TrackAudioCache, start: float, end: float, *, floor_db: float
) -> list[VoicedRun]:
    """Voiced speech runs inside ``[start, end)``.

    Frames start on the absolute 10 ms grid, so a run's bounds depend only on the
    audio, not on the window the caller asked for. A run edge is exact to one frame:
    voice surely fills ``(run.start + FRAME_SEC, run.end - FRAME_SEC)`` and is surely
    absent outside ``[run.start, run.end]``.
    """
    sr = int(cache.waveform.sample_rate)
    frame = max(1, round(sr * FRAME_SEC))
    hop = max(1, round(sr * HOP_SEC))
    t0 = math.floor(max(0.0, start) / HOP_SEC) * HOP_SEC
    samples = cache.window(t0, end)
    levels = frame_rms_db(samples, frame, hop)
    if levels.size == 0:
        return []
    active = bridge_short_dips(levels >= floor_db, max(1, round(_BRIDGE_SEC / HOP_SEC)))
    runs: list[VoicedRun] = []
    for i, j in bool_runs(active):
        lo, hi = i * hop, (j - 1) * hop + frame
        probes = voicing_probes(
            samples[lo:hi],
            sr,
            probe_sec=_PROBE_SEC,
            hop_sec=HOP_SEC,
            fmin=_F0_MIN_HZ,
            fmax=_F0_MAX_HZ,
        )
        if int(np.count_nonzero(probes >= VOICED_PEAK)) < _MIN_VOICED_FRAMES:
            continue
        runs.append((t0 + lo / sr, t0 + hi / sr))
    return runs


def run_straddling(runs: Sequence[VoicedRun], t: float) -> VoicedRun | None:
    """The run that surely holds voice on both sides of ``t``, if any."""
    return next((r for r in runs if r[0] + FRAME_SEC < t < r[1] - FRAME_SEC), None)


def voiced_sec_inside(runs: Sequence[VoicedRun], start: float, end: float) -> float:
    """Longest stretch of one voiced run that lies inside ``[start, end]``."""
    return max((max(0.0, min(r[1], end) - max(r[0], start)) for r in runs), default=0.0)
