"""Mastering plan: two-pass loudnorm, or static gain into a true-peak-safe limiter."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar

# The limiter sits this far under the true-peak ceiling: room for the final trim
# to make up the loudness the limiter took without crossing the ceiling.
LIMITER_MARGIN_DB = 0.5
# Limiter renders before the final trim: the first at the planned gain, then one
# re-drive per shortfall the trim cannot make up under the ceiling.
LIMITER_MAX_RENDERS = 3
# alimiter limits sample peaks; at 4x the rate they track ebur128's true peak.
LIMITER_OVERSAMPLE = 4
LIMITER_ATTACK_MS = 5.0
LIMITER_RELEASE_MS = 50.0
# ebur128 prints the true peak to one decimal, so the printed value can sit up to
# half that under the real peak. The trim keeps this much extra headroom.
TRUE_PEAK_PRINT_ROUNDING_DB = 0.05
# ebur128's absolute gate floor and its 400 ms momentary block: a premix at or
# under the floor, or shorter than a block, has no integrated loudness to plan from.
LOUDNESS_GATE_FLOOR_LUFS = -70.0
LOUDNESS_GATE_SEC = 0.4


@dataclass(frozen=True)
class LoudnormPlan:
    """Two-pass loudnorm. Linear when the gain fits under the ceiling; loudnorm
    still falls back to dynamic when the premix LRA exceeds ``master.lra``."""

    # False: the premix has no usable pass-1 stats, so loudnorm measures it itself.
    two_pass: bool
    kind: ClassVar[str] = "loudnorm"


@dataclass(frozen=True)
class LimiterPlan:
    """Static ``gain_db`` (what linear loudnorm would apply), a true-peak-safe
    limiter under the ceiling, then a trim onto the target loudness."""

    gain_db: float
    kind: ClassVar[str] = "limit"


MasterPlan = LoudnormPlan | LimiterPlan


def plan_master(
    stats: dict[str, float] | None,
    *,
    integrated_lufs: float,
    true_peak_db: float,
    duration_sec: float,
) -> MasterPlan:
    """Pick the mastering plan from the premix's pass-1 ebur128 stats.

    Linear loudnorm applies ``integrated_lufs - input_i`` to every sample, so it
    can only reach the target when the premix true peak plus that gain stays at
    or under ``true_peak_db``. Past that, loudnorm would fall back to dynamic
    mode and under-shoot, so the plan limits the peaks instead. Stats that are
    missing, at the gating floor, or from a premix shorter than the gate would
    plan an absurd gain; those keep single-pass loudnorm.
    """
    if (
        stats is None
        or stats["input_i"] <= LOUDNESS_GATE_FLOOR_LUFS
        or (duration_sec < LOUDNESS_GATE_SEC)
    ):
        return LoudnormPlan(two_pass=False)
    gain_db = round(integrated_lufs - stats["input_i"], 2)
    if round(stats["input_tp"] + gain_db, 2) <= true_peak_db:
        return LoudnormPlan(two_pass=True)
    return LimiterPlan(gain_db)


def limiter_af(drive_db: float, limit_db: float, sample_rate: int) -> str:
    """Gain, then alimiter at ``limit_db`` on 4x-oversampled audio, back to ``sample_rate``.

    ``level=disabled`` keeps alimiter from normalizing its output back up to 0 dBFS;
    ``latency=1`` removes its lookahead delay so the master stays sample-aligned.
    """
    limit = 10 ** (limit_db / 20)
    return (
        f"volume={drive_db}dB,"
        f"aresample={sample_rate * LIMITER_OVERSAMPLE},"
        f"alimiter=limit={limit:.6f}:attack={LIMITER_ATTACK_MS}:release={LIMITER_RELEASE_MS}"
        ":level=disabled:latency=1,"
        f"aresample={sample_rate}"
    )


@dataclass(frozen=True)
class LimiterReport:
    """What the limiter plan did, for ``master_qc.json``."""

    gain_db: float  # planned gain: target minus premix integrated loudness
    drive_db: float  # gain into the limiter after re-drives
    limit_db: float  # limiter ceiling (true-peak ceiling minus LIMITER_MARGIN_DB)
    renders: int  # limiter renders run
    converged: bool  # the trim reached the target loudness under the ceiling
    trim_db: float  # gain after the limiter, onto the target loudness
    peak_reduction_db: float  # gain reduction on the loudest true peak
    loudness_reduction_lu: float  # integrated loudness the limiter took (average reduction)


@dataclass(frozen=True)
class MasterResult:
    path: Path
    plan: MasterPlan
    # The premix's pass-1 stats (None when ebur128 could not measure them).
    input_stats: dict[str, float] | None
    # "linear" | "dynamic" from loudnorm's JSON; None for the limiter plan or no JSON.
    normalization_type: str | None
    limiter: LimiterReport | None
