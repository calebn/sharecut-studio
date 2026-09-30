from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import numpy as np


@dataclass(frozen=True)
class LongDelayConfig:
    window_sec: float = 0.5
    max_lag_sec: float = 0.5
    max_windows: int = 48
    min_ncc: float = 0.5
    null_margin: float = 0.2
    null_shifts_sec: tuple[float, ...] = (-13.1, -7.3, 7.3, 13.1)
    min_null_windows: int = 2
    peak_margin: float = 0.05
    peak_exclusion_sec: float = 0.002
    min_rms: float = 0.0001


@dataclass(frozen=True)
class LongDelayEvidence:
    source_track_id: str
    bleed_track_id: str
    start: float
    end: float
    lag_ms: float | None
    peak_ncc: float
    null_ncc: float
    reason: str
    owner_absence_proven: bool = False

    @property
    def supported(self) -> bool:
        return self.reason == "supported"

    def to_dict(self) -> dict[str, Any]:
        return {**asdict(self), "supported": self.supported}


def _match(
    reference: np.ndarray,
    target: np.ndarray,
    first: int,
    last: int,
    radius: int,
    shift: int,
    exclusion: int,
    min_rms: float,
) -> tuple[int, float, float] | None:
    ref_first, ref_last = first - radius + shift, last + radius + shift
    if ref_first < 0 or ref_last > reference.size:
        return None
    own = target[first:last].astype(np.float64)
    own -= own.mean()
    energy = float(own @ own)
    if energy < own.size * min_rms**2:
        return None
    peer = reference[ref_first:ref_last].astype(np.float64)
    size = 1 << (peer.size + own.size - 2).bit_length()
    numerator = np.fft.irfft(np.fft.rfft(peer, size) * np.fft.rfft(own[::-1], size), size)[
        own.size - 1 : peer.size
    ]
    sums = np.cumsum(np.r_[0, peer])
    squares = np.cumsum(np.r_[0, peer * peer])
    power = (
        squares[own.size :]
        - squares[: -own.size]
        - (sums[own.size :] - sums[: -own.size]) ** 2 / own.size
    )
    usable = power >= own.size * min_rms**2
    if not np.any(usable):
        return None
    scores = np.zeros(power.size, dtype=np.float64)
    scores[usable] = np.minimum(1.0, np.abs(numerator[usable]) / np.sqrt(power[usable] * energy))
    index = int(scores.argmax())
    peak = float(scores[index])
    scores[max(0, index - exclusion) : index + exclusion + 1] = 0
    runner_up = float(scores.max())
    if index in (0, scores.size - 1):
        return None
    return radius - index, peak, runner_up


def measure_long_delay_regions(
    source: np.ndarray,
    bleed: np.ndarray,
    *,
    sample_rate: int,
    t0: float,
    source_track_id: str,
    bleed_track_id: str,
    config: LongDelayConfig | None = None,
    start_sec: float | None = None,
    end_sec: float | None = None,
) -> tuple[LongDelayEvidence, ...]:
    """Measure independent target windows with extended reference context and shifted nulls.

    Region bounds use the bleed lane's clock. Positive lag means the copy follows
    the direct source. Copy evidence never establishes absence of overlapping owner.
    """
    cfg = config or LongDelayConfig()
    if sample_rate <= 0 or cfg.window_sec <= 0 or cfg.max_lag_sec <= 0 or cfg.max_windows <= 0:
        raise ValueError("long-delay evidence needs positive rate, window, bound, and budget")
    count = min(source.size, bleed.size)
    frame = max(8, round(cfg.window_sec * sample_rate))
    radius = max(1, round(cfg.max_lag_sec * sample_rate))
    first = max(radius, round(((t0 if start_sec is None else start_sec) - t0) * sample_rate))
    last = min(
        count - radius,
        round(((end_sec if end_sec is not None else t0 + count / sample_rate) - t0) * sample_rate),
    )
    starts = np.arange(first, last - frame + 1, frame, dtype=np.int64)
    if starts.size > cfg.max_windows:
        starts = starts[np.linspace(0, starts.size - 1, cfg.max_windows).astype(int)]
    exclusion = max(1, round(cfg.peak_exclusion_sec * sample_rate))
    rows: list[LongDelayEvidence] = []
    for value in starts:
        lo, hi = int(value), int(value) + frame
        observed = _match(source, bleed, lo, hi, radius, 0, exclusion, cfg.min_rms)
        if observed is None:
            continue
        lag, peak, competitor = observed
        nulls = [
            result[1]
            for shift in cfg.null_shifts_sec
            if (
                result := _match(
                    source,
                    bleed,
                    lo,
                    hi,
                    radius,
                    round(shift * sample_rate),
                    exclusion,
                    cfg.min_rms,
                )
            )
            is not None
        ]
        null = max(nulls, default=1.0)
        reason = "supported"
        if peak < cfg.min_ncc:
            reason = "weak_copy"
        elif len(nulls) < cfg.min_null_windows:
            reason = "insufficient_null_context"
        elif peak - null < cfg.null_margin:
            reason = "periodic_or_null_similarity"
        elif peak - competitor < cfg.peak_margin:
            reason = "ambiguous_delay"
        rows.append(
            LongDelayEvidence(
                source_track_id,
                bleed_track_id,
                t0 + lo / sample_rate,
                t0 + hi / sample_rate,
                lag / sample_rate * 1000,
                peak,
                null,
                reason,
            )
        )
    return tuple(rows)
