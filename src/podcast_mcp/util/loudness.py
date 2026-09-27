"""BS.1770 integrated loudness from ebur128 momentary blocks, optionally speech-gated.

ebur128's per-100 ms ``M`` value is the loudness of the 400 ms window ending at
``t``: exactly the BS.1770 gating block. Gating a subset of blocks (a speaker's
own words) gives that speaker's loudness without bleed or silence.
"""

from __future__ import annotations

import math
from bisect import bisect_right
from collections.abc import Sequence
from dataclasses import dataclass

ABS_GATE_LUFS = -70.0
REL_GATE_LU = 10.0
BLOCK_SEC = 0.4
MIN_SPEECH_BLOCKS = 30  # 3 s of 100 ms steps; below this fall back to ungated


@dataclass(frozen=True)
class GatedLoudness:
    lufs: float | None
    speech_gated: bool


def _power(lufs: float) -> float:
    return 10.0 ** ((lufs + 0.691) / 10.0)


def _lufs(power: float) -> float:
    return -0.691 + 10.0 * math.log10(power)


def integrated_lufs_from_blocks(momentary: Sequence[float]) -> float | None:
    """Absolute (-70 LUFS) then relative (-10 LU) gated mean of block powers, 2 dp."""
    loud = [m for m in momentary if math.isfinite(m) and m > ABS_GATE_LUFS]
    if not loud:
        return None
    rel = _lufs(sum(map(_power, loud)) / len(loud)) - REL_GATE_LU
    kept = [m for m in loud if m > rel]
    return round(_lufs(sum(map(_power, kept)) / len(kept)), 2)


def speech_blocks(
    blocks: Sequence[tuple[float, float]], intervals: Sequence[tuple[float, float]]
) -> list[float]:
    """Momentary values whose window centre (t - 0.2 s) lies inside a speech interval."""
    merged: list[list[float]] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    starts = [s for s, _e in merged]
    chosen: list[float] = []
    for t, m in blocks:
        centre = t - BLOCK_SEC / 2
        i = bisect_right(starts, centre) - 1
        if i >= 0 and centre < merged[i][1]:
            chosen.append(m)
    return chosen


def speech_gated_lufs(
    blocks: Sequence[tuple[float, float]], intervals: Sequence[tuple[float, float]]
) -> GatedLoudness:
    """Speech-gated loudness; falls back to ungated with too little speech."""
    if intervals:
        chosen = speech_blocks(blocks, intervals)
        if len(chosen) >= MIN_SPEECH_BLOCKS:
            lufs = integrated_lufs_from_blocks(chosen)
            if lufs is not None:
                return GatedLoudness(lufs, True)
    return GatedLoudness(integrated_lufs_from_blocks([m for _t, m in blocks]), False)
