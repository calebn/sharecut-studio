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

A segment is a run of spurts at its own best lag, with correlation at least
``MIN_CORRELATION``, the peak inside the search, and enough evidence to pin it: every lag
beyond the deadband fits worse by ``CONFIDENCE_NATS`` (its likelihood-ratio interval lies
inside the deadband). A short phrase with a sharp peak passes; a long stretch with a flat
correlation does not, so the floor scales with the evidence, not with a frame count. Dynamic
programming picks the segments that minimise ``sum(n / 2 * log(1 - r^2))`` (``n`` in
independent frames, ``FRAME_SEC`` apart) plus ``STEP_LLR`` per segment, where the widest
silence between neighbours holds the step plus ``EDGE_SEC`` on each side. A second pass
then keeps the best subset of those steps in which every step exceeds the deadband,
measuring each step between the merged pieces either side of it: two neighbours inside
the deadband are one piece, and the step before them is judged against that piece.
``STEP_LLR`` is about the BIC cost of a step on a 28-minute lane. Cross-validation on the
lab tape (fit on alternate spurts, score the rest) scores every cost from 2.5 to 40 above
one constant lag, best at 2.5-5 and still better at 10.

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
# Half the 95% chi-square(1) quantile: the likelihood-ratio interval of a piece's lag.
CONFIDENCE_NATS = 1.92
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


Run = tuple[int, int, int]


def _valid(r: np.ndarray, n: np.ndarray, smallest: int) -> np.ndarray:
    """Lags a segment may sit at: its own best, inside the search, and pinned by its evidence.

    Pinned means every lag ``smallest`` hops or more away (beyond the deadband) fits worse
    by at least ``CONFIDENCE_NATS``: the likelihood-ratio interval of the lag lies inside
    the deadband. A short stretch with a sharp peak qualifies; a long one with a flat
    correlation does not.
    """
    size = r.shape[-1]
    best = np.argmax(r, axis=-1)
    fit = _log_fit(r, n)
    far = np.abs(np.arange(size) - best[..., None]) >= smallest
    worse = fit - np.take_along_axis(fit, best[..., None], axis=-1)
    pinned = np.where(far, worse, np.inf).min(axis=-1) >= CONFIDENCE_NATS
    inside = (best > 0) & (best < size - 1)
    return (
        (r == r.max(axis=-1, keepdims=True)) & (r >= MIN_CORRELATION) & (pinned & inside)[..., None]
    )


def _partition(cum: np.ndarray, largest: np.ndarray, smallest: int) -> list[Run] | None:
    """Blocks split into runs ``(first, end, lag)`` minimising fit plus ``STEP_LLR`` per run.

    A step may be any size its silence holds; whether it is worth applying is
    :func:`_keep_steps`'s call, once each piece is measured against its real neighbours.
    """
    count, size = cum.shape[0] - 1, cum.shape[1]
    offsets = np.abs(np.subtract.outer(np.arange(size), np.arange(size)))
    # total[b, k]: best cost of blocks [0, b) ending on lag k; entry[b, k]: best cost of
    # blocks [0, b) followed by a step into lag k at block b (0 for b = 0).
    total = np.full((count + 1, size), np.inf)
    entry = np.full((count + 1, size), np.inf)
    start = np.zeros((count + 1, size), dtype=int)
    came = np.zeros((count + 1, size), dtype=int)
    entry[0] = 0.0
    for b in range(1, count + 1):
        r, n = _correlation(cum[b] - cum[:b])
        options = entry[:b] + np.where(_valid(r, n, smallest), _log_fit(r, n), np.inf)
        start[b] = np.argmin(options, axis=0)
        total[b] = options[start[b], np.arange(size)] + STEP_LLR
        if b < count:
            allowed = (offsets > 0) & (offsets <= largest[b])
            stepped = np.where(allowed, total[b][None, :], np.inf)
            came[b] = np.argmin(stepped, axis=1)
            entry[b] = stepped[np.arange(size), came[b]]
    b, k = count, int(np.argmin(total[count]))
    if not np.isfinite(total[count, k]):
        return None
    runs: list[Run] = []
    while b > 0:
        a = int(start[b, k])
        runs.append((a, b, k))
        b, k = a, int(came[a, k])
    return runs[::-1]


def _keep_steps(
    runs: list[Run], cum: np.ndarray, largest: np.ndarray, smallest: int
) -> list[Run] | None:
    """The best subset of ``runs``' steps where every kept step exceeds the deadband.

    Dropping a step merges its two runs into one piece at that piece's own best lag, and
    each remaining step is judged between the merged pieces either side of it, so a step
    is never rejected against a neighbour that a dropped step created. A kept step is at
    least ``smallest`` hops and fits its silence.
    """
    bounds = [a for a, _b, _k in runs] + [runs[-1][1]]
    m = len(runs)
    lag = np.full((m + 1, m + 1), -1, dtype=int)
    fit = np.full((m + 1, m + 1), np.inf)
    for i in range(m):
        ends = np.array(bounds[i + 1 :])
        r, n = _correlation(cum[ends] - cum[bounds[i]])
        valid = _valid(r, n, smallest)
        for j, row in zip(range(i + 1, m + 1), valid, strict=True):
            if row.any():
                lag[i, j] = int(np.argmax(row))
                fit[i, j] = float(_log_fit(r[j - i - 1, lag[i, j]], n[j - i - 1, lag[i, j]]))
    # best[j, i]: cost of bounds [0, j) whose last piece is (i, j); came[j, i]: the piece's start before.
    best = np.full((m + 1, m + 1), np.inf)
    came = np.full((m + 1, m + 1), -1, dtype=int)
    best[1:, 0] = fit[0, 1:] + STEP_LLR
    for j in range(2, m + 1):
        for i in range(1, j):
            if not np.isfinite(fit[i, j]):
                continue
            step = np.abs(lag[:i, i] - lag[i, j])
            ok = np.isfinite(best[i, :i]) & (step >= smallest) & (step <= largest[bounds[i]])
            if ok.any():
                before = np.where(ok, best[i, :i], np.inf)
                came[j, i] = int(np.argmin(before))
                best[j, i] = before[came[j, i]] + fit[i, j] + STEP_LLR
    i = int(np.argmin(best[m]))
    if not np.isfinite(best[m, i]):
        return None
    kept: list[Run] = []
    j = m
    while True:
        kept.append((bounds[i], bounds[j], int(lag[i, j])))
        if i == 0:
            return kept[::-1]
        i, j = int(came[j, i]), i


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
    # The largest lag step (hops) each gap holds: the silence less its edges.
    largest = np.floor(((gap_at[:, 1] - gap_at[:, 0]) * HOP_SEC - 2 * EDGE_SEC) / HOP_SEC + 1e-9)
    smallest = int(np.floor(deadband_sec / HOP_SEC + 1e-9)) + 1
    runs = _partition(cum, largest, smallest)
    if runs is None:
        return None
    runs = _keep_steps(runs, cum, largest, smallest)
    if runs is None or len(runs) == 1:
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
