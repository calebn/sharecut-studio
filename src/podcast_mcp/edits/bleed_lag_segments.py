"""Where a lane's latency steps during the episode, split at the lane's own silences.

A Zoom-style jitter buffer re-times a track when its talker resumes after a pause, then
eases back over seconds to tens of seconds. On the lab tape Audra's track trails her bleed
on Caleb's mic by 130-150 ms most of the time and by 185-225 ms in the first stretch after
several of her pauses, so one latency per lane leaves those stretches echoing.

This works in the lane's source time against the reference mic's envelope on the
timeline: a source lag ``lam`` pairs mic frame ``f`` with source frame ``f + lam``, and the
lane plays in sync where its timeline-minus-source shift is ``-lam``. Units are the lane's
talk spurts (its full-band envelope open, split at silences of at least ``MIN_GAP_SEC``).
Per spurt and
candidate lag the Pearson sums over source-dominant frames are kept, so any run of spurts
is measured exactly as one window over its frames.

A segment is a run of spurts at its own best lag, with at least ``MIN_SEGMENT_FRAMES``
frames, correlation at least ``MIN_CORRELATION`` and the peak inside the search. Dynamic
programming picks the segments that minimise ``sum(n / 2 * log(1 - r^2))`` (``n`` in
independent frames, ``FRAME_SEC`` apart) plus ``STEP_LLR`` per segment, where neighbours
differ by more than the deadband and the widest silence between them holds the step plus
``EDGE_SEC`` on each side. ``STEP_LLR`` is about the BIC cost of a step on a 28-minute
lane. Cross-validation on the lab tape (fit on alternate spurts, score the rest) scores
every cost from 2.5 to 40 above one constant lag, best at 2.5-5 and still better at 10.

Lags are searched ``SEARCH_SEC`` either side of the lane's pooled lag. Speech envelopes
correlate again one syllable away (about 200 ms), so a wider search lets a short stretch
lock onto a neighbouring syllable. Everything is measured from the lane's media and the
reference, never from where the pieces sit, so a re-run finds the same segments.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from podcast_mcp.edits.bleed_latency import DOMINANCE_DB, FRAME_SEC, HOP_SEC, MAX_LAG_SEC, OPEN_DB
from podcast_mcp.engines.envelope_lag import LEVEL_FLOOR_DB, MIN_CORRELATION

MIN_GAP_SEC = 0.06
EDGE_SEC = 0.02
SEARCH_SEC = 0.1
MIN_SEGMENT_FRAMES = 200
STEP_LLR = 10.0


@dataclass(frozen=True)
class LagSegment:
    """From ``start_sec`` (lane source time) the lane plays at timeline = source + ``shift_sec``.

    ``gap_sec`` is the silence (source time) the step into this segment sits in.
    """

    start_sec: float
    shift_sec: float
    frames: int
    correlation: float
    gap_sec: tuple[float, float] | None = None


def _talk_spurts(source: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """First and last open frame of each talk spurt."""
    open_frames = np.flatnonzero(source > OPEN_DB)
    if open_frames.size == 0:
        return open_frames, open_frames
    breaks = np.flatnonzero(np.diff(open_frames) >= round(MIN_GAP_SEC / HOP_SEC))
    firsts = np.concatenate([open_frames[:1], open_frames[breaks + 1]])
    lasts = np.concatenate([open_frames[breaks], open_frames[-1:]])
    return firsts, lasts


def _dominant(source: np.ndarray, mic: np.ndarray, lags: np.ndarray) -> np.ndarray:
    """Mic frames where the source, at some searched lag, is open and out-levels the mic."""
    first, last = int(lags[0]), int(lags[-1])
    before = max(0, -first)
    padded = np.concatenate(
        [np.full(before, LEVEL_FLOOR_DB), source, np.full(max(0, last) + 1, LEVEL_FLOOR_DB)]
    )
    windows = np.lib.stride_tricks.sliding_window_view(padded[first + before :], last - first + 1)
    near = windows.max(axis=1)[: mic.size]
    return np.flatnonzero((near > OPEN_DB) & (near - mic[: near.size] >= DOMINANCE_DB))


def _sums(
    source: np.ndarray, mic: np.ndarray, owner: np.ndarray, units: int, lags: np.ndarray
) -> np.ndarray:
    """``[unit, lag, (n, Σx, Σy, Σxx, Σyy, Σxy)]``: x the mic, y the source, unit by source frame."""
    sums = np.zeros((units, lags.size, 6))
    frames = _dominant(source, mic, lags)
    for j, lag in enumerate(lags):
        f = frames[(frames + lag >= 0) & (frames + lag < source.size)]
        x, y, k = mic[f], source[f + lag], owner[f + lag]
        for col, value in enumerate((np.ones_like(x), x, y, x * x, y * y, x * y)):
            sums[:, j, col] = np.bincount(k, weights=value, minlength=units)
    return sums


def _correlation(sums: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Correlation and frame count per lag (the last axis of ``sums`` holds the six sums)."""
    n, sx, sy, sxx, syy, sxy = np.moveaxis(sums, -1, 0)
    with np.errstate(invalid="ignore", divide="ignore"):
        r = (sxy - sx * sy / n) / np.sqrt((sxx - sx * sx / n) * (syy - sy * sy / n))
    return np.nan_to_num(r, nan=0.0), n


def _log_fit(r: np.ndarray, n: np.ndarray) -> np.ndarray:
    """Gaussian log-likelihood of a lag in independent frames (lower is a better fit)."""
    return n * HOP_SEC / FRAME_SEC / 2 * np.log1p(-(np.clip(r, 0.0, 0.999) ** 2))


def _pooled_lag(source: np.ndarray, mic: np.ndarray, around: int) -> int | None:
    """Whole-lane best lag within ``MAX_LAG_SEC`` of ``around`` (hops), None on the edge."""
    reach = round(MAX_LAG_SEC / HOP_SEC)
    lags = np.arange(around - reach, around + reach + 1)
    r, _n = _correlation(_sums(source, mic, np.zeros(source.size, dtype=int), 1, lags)[0])
    k = int(np.argmax(r))
    return None if k in (0, lags.size - 1) else int(lags[k])


def lag_segments(
    source: np.ndarray,
    mic: np.ndarray,
    *,
    heard: np.ndarray,
    around_sec: float,
    deadband_sec: float,
) -> tuple[LagSegment, ...] | None:
    """Piecewise shift of a lane (``source``: its media envelope) against the reference mic.

    All envelopes are on the ``HOP_SEC`` grid. ``heard`` is the lane's full-band envelope,
    which decides where it is silent: a decode band-limited for lag work hides sibilants
    above its Nyquist (an "s" at -26 dBFS read as -61 dB at 8 kHz on the lab tape).
    ``around_sec`` is roughly the lane's source lag (minus its timeline-minus-source
    shift). None when no step stands.
    """
    firsts, lasts = _talk_spurts(heard[: source.size])
    centre = _pooled_lag(source, mic, round(around_sec / HOP_SEC)) if firsts.size > 1 else None
    if centre is None:
        return None
    reach = round(SEARCH_SEC / HOP_SEC)
    lags = np.arange(centre - reach, centre + reach + 1)
    # Each spurt owns its frames from the middle of the gap before to the middle after.
    owner = np.searchsorted((lasts[:-1] + firsts[1:]) // 2, np.arange(source.size), side="right")
    sums = _sums(source, mic, owner, firsts.size, lags)
    # Spurts without a dominant frame carry no evidence: fold each into the block before,
    # keeping its gaps as places a step can go.
    evidence = np.flatnonzero(sums[:, :, 0].max(axis=1) > 0)
    if evidence.size < 2:
        return None
    blocks = np.add.reduceat(sums, evidence, axis=0)
    blocks[0] += sums[: evidence[0]].sum(axis=0)
    cum = np.concatenate([np.zeros((1, *blocks.shape[1:])), np.cumsum(blocks, axis=0)])
    count = evidence.size
    # The widest silence before each block (source frames), where a step into it would go.
    gap_at = np.zeros((count, 2), dtype=int)
    for block in range(1, count):
        spurts = np.arange(evidence[block - 1], evidence[block])
        g = spurts[int(np.argmax(firsts[spurts + 1] - lasts[spurts]))]
        gap_at[block] = lasts[g] + 1, firsts[g + 1]
    # Lag steps (hops) a gap can take: beyond the deadband, within the silence less its edges.
    smallest = int(np.floor(deadband_sec / HOP_SEC + 1e-9)) + 1
    largest = np.floor(((gap_at[:, 1] - gap_at[:, 0]) * HOP_SEC - 2 * EDGE_SEC) / HOP_SEC + 1e-9)
    offsets = np.abs(np.subtract.outer(np.arange(lags.size), np.arange(lags.size)))
    edge = np.zeros(lags.size, dtype=bool)
    edge[[0, -1]] = True
    # total[b, k]: best cost of blocks [0, b) ending on lag k; entry[b, k]: best cost of
    # blocks [0, b) followed by a step into lag k at block b (0 for b = 0).
    total = np.full((count + 1, lags.size), np.inf)
    entry = np.full((count + 1, lags.size), np.inf)
    start = np.zeros((count + 1, lags.size), dtype=int)
    came = np.zeros((count + 1, lags.size), dtype=int)
    entry[0] = 0.0
    for b in range(1, count + 1):
        r, n = _correlation(cum[b] - cum[:b])
        own = r == r.max(axis=1, keepdims=True)
        cost = np.where(
            own & (n >= MIN_SEGMENT_FRAMES) & (r >= MIN_CORRELATION) & ~edge,
            _log_fit(r, n),
            np.inf,
        )
        options = entry[:b] + cost
        start[b] = np.argmin(options, axis=0)
        total[b] = options[start[b], np.arange(lags.size)] + STEP_LLR
        if b < count:
            allowed = (offsets >= smallest) & (offsets <= largest[b])
            stepped = np.where(allowed, total[b][None, :], np.inf)
            came[b] = np.argmin(stepped, axis=1)
            entry[b] = stepped[np.arange(lags.size), came[b]]
    runs: list[tuple[int, int, int]] = []
    b, k = count, int(np.argmin(total[count]))
    if not np.isfinite(total[count, k]):
        return None
    while b > 0:
        a = int(start[b, k])
        runs.append((a, b, k))
        b, k = a, int(came[a, k])
    runs.reverse()
    if len(runs) == 1:
        return None
    segments = []
    for a, b, k in runs:
        r, n = _correlation(cum[b] - cum[a])
        quiet = gap_at[a] * HOP_SEC if a else None
        segments.append(
            LagSegment(
                start_sec=0.0 if quiet is None else float(quiet.mean()),
                shift_sec=float(-lags[k] * HOP_SEC),
                frames=int(n[k]),
                correlation=round(float(r[k]), 3),
                gap_sec=None if quiet is None else (float(quiet[0]), float(quiet[1])),
            )
        )
    return tuple(segments)
