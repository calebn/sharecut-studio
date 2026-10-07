"""Where a lane's latency steps during the episode, split at the lane's own silences.

A Zoom-style jitter buffer re-times a track when its talker resumes after a pause, then
eases back over seconds to tens of seconds. On the lab tape Audra's track trails her bleed
on Caleb's mic by 130-150 ms most of the time and by 185-225 ms in the first stretch after
several of her pauses, so one latency per lane leaves those stretches echoing.

This works in the lane's source time against every pair the lane shares with a track on
the reference clock, in either direction: the lane's voice copied onto another mic, or
another voice copied onto the lane's mic. Both copies on the lane's track move with its
latency. A source lag ``lam`` pairs the other track's frame ``f`` with source frame
``f + lam``, and the lane plays in sync where its timeline-minus-source shift is ``-lam``.
Units are the lane's talk spurts (its full-band envelope open, split at silences of at
least ``MIN_GAP_SEC``). A frame is silent when its RMS is under ``OPEN_DB`` and its every
sample peaks under ``SKIP_PEAK_DB``, so a step skips or repeats nothing louder. Per spurt,
pair and candidate lag the Pearson sums over frames where the talker out-levels the copy
are kept, so any run of spurts is measured exactly as one window over its frames, and
pairs add as independent log-likelihoods.

A segment is a run of spurts at its own best lag, with correlation at least
``MIN_CORRELATION``, the peak inside the search, and enough evidence to pin it: every lag
beyond the deadband fits worse by ``CONFIDENCE_NATS`` (its likelihood-ratio interval lies
inside the deadband), counted over the talker's own voiced frames less the three a
correlation spends. A short phrase with a sharp peak passes; a long stretch with a flat
correlation does not, and neither does a lone click, whose surrounding silence correlates
perfectly with the copy's. The floor scales with the evidence, not with a frame count.
Dynamic programming picks the segments that minimise ``sum(n / 2 * log(1 - r^2))`` (``n``
in independent frames, ``FRAME_SEC`` apart) plus a step cost per segment, where the
widest silence between neighbours holds the step plus ``EDGE_SEC`` on each side. A second
pass then keeps the best subset of those steps in which every step exceeds the deadband,
measuring each step between the merged pieces either side of it: two neighbours inside
the deadband are one piece, and the step before them is judged against that piece.

The step cost is chosen per lane by cross-validation: spurts are dealt to ``FOLDS``
folds, each fold is predicted from pieces fitted on the others, and of the
``STEP_COSTS`` (or no steps at all) whose held-out fit is within ``CONFIDENCE_NATS`` of
the best, the largest wins. A clean recording keeps only clear steps; a noisy one with
many small re-timings gets a cheaper step only when held-out speech confirms it.

Each pair is searched ``SEARCH_SEC`` either side of its steady lag. Speech envelopes
correlate again one syllable away (about 200 ms), so a wider search lets a short stretch
lock onto a neighbouring syllable. Everything is measured from the lane's media and the
other tracks, never from where the pieces sit, so a re-run finds the same segments.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from podcast_mcp.edits.bleed_latency import DOMINANCE_DB, FRAME_SEC, HOP_SEC, OPEN_DB
from podcast_mcp.engines.envelope_lag import LEVEL_FLOOR_DB, MIN_CORRELATION

MIN_GAP_SEC = 0.06
EDGE_SEC = 0.02
# A step skips or repeats only audio whose 30 ms RMS is under OPEN_DB and whose every
# sample peaks under this: 10 dB over the RMS gate, about the crest of a noise floor
# sitting at the gate, so a click the RMS averages away still counts as sound.
SKIP_PEAK_DB = OPEN_DB + 10.0
SEARCH_SEC = 0.1
# Half the 95% chi-square(1) quantile: the likelihood-ratio interval of a piece's lag.
CONFIDENCE_NATS = 1.92
# Step costs (nats) cross-validation chooses from, per lane, over FOLDS interleaved folds.
STEP_COSTS = (0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0)
FOLDS = 5


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


def _talk_spurts(heard: np.ndarray, heard_peak: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """First and last open frame of each talk spurt (RMS or sample peak over its gate)."""
    open_frames = np.flatnonzero((heard > OPEN_DB) | (heard_peak[: heard.size] > SKIP_PEAK_DB))
    if open_frames.size == 0:
        return open_frames, open_frames
    breaks = np.flatnonzero(np.diff(open_frames) >= round(MIN_GAP_SEC / HOP_SEC))
    firsts = np.concatenate([open_frames[:1], open_frames[breaks + 1]])
    lasts = np.concatenate([open_frames[breaks], open_frames[-1:]])
    return firsts, lasts


@dataclass(frozen=True)
class BleedPair:
    """One pair's evidence: ``other`` is another track's envelope on the reference clock.

    ``lane_talks``: the lane's voice is copied onto ``other``'s mic; otherwise ``other``'s
    voice is copied onto the lane's mic. Either way the copy on the lane's track moves with
    the lane's latency, so both directions see the same steps. ``lag_sec`` is the pair's
    steady lag in lane source time (lane frame ``f + lag`` lines up with ``other`` frame
    ``f``): the lane's latency plus the copy's path delay, from the latency solve.
    """

    other: np.ndarray
    lane_talks: bool
    lag_sec: float


def _frames(source: np.ndarray, pair: BleedPair, lags: np.ndarray) -> np.ndarray:
    """``other`` frames where the talker is open and out-levels the copy at every searched lag."""
    first, last = int(lags[0]), int(lags[-1])
    before = max(0, -first)
    padded = np.concatenate(
        [np.full(before, LEVEL_FLOOR_DB), source, np.full(max(0, last) + 1, LEVEL_FLOOR_DB)]
    )
    windows = np.lib.stride_tricks.sliding_window_view(padded[first + before :], last - first + 1)
    other = pair.other
    near = windows.max(axis=1)[: other.size]
    talker, copy = (near, other[: near.size]) if pair.lane_talks else (other[: near.size], near)
    return np.flatnonzero((talker > OPEN_DB) & (talker - copy >= DOMINANCE_DB))


def _sums(
    source: np.ndarray, pair: BleedPair, owner: np.ndarray, units: int, lags: np.ndarray
) -> np.ndarray:
    """``[unit, lag, (n, Σx, Σy, Σxx, Σyy, Σxy, voiced)]``: x the other track, y the lane.

    Units go by lane frame. ``voiced`` counts the frames where the talker itself is open
    at that lag; the rest pair the copy with the talker's silence around a word.
    """
    sums = np.zeros((units, lags.size, 7))
    frames = _frames(source, pair, lags)
    for j, lag in enumerate(lags):
        f = frames[(frames + lag >= 0) & (frames + lag < source.size)]
        x, y, k = pair.other[f], source[f + lag], owner[f + lag]
        voiced = (y if pair.lane_talks else x) > OPEN_DB
        for col, value in enumerate(
            (np.ones_like(x), x, y, x * x, y * y, x * y, voiced.astype(float))
        ):
            sums[:, j, col] = np.bincount(k, weights=value, minlength=units)
    return sums


def _correlation(sums: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Correlation and frame count per lag (the last axis of ``sums`` holds the sums)."""
    n, sx, sy, sxx, syy, sxy = np.moveaxis(sums[..., :6], -1, 0)
    with np.errstate(invalid="ignore", divide="ignore"):
        r = (sxy - sx * sy / n) / np.sqrt((sxx - sx * sx / n) * (syy - sy * sy / n))
    return np.nan_to_num(r, nan=0.0), n


def _fit(span: np.ndarray, smallest: int) -> tuple[np.ndarray, np.ndarray]:
    """Fit per lag offset over every pair, and the offsets a segment may sit at.

    ``span`` is ``[..., pair, offset, sums]``. The fit is the Gaussian log-likelihood
    ``sum(n / 2 * log(1 - r^2))`` over pairs (``n`` in independent frames, lower is
    better). A segment sits at its own best offset, inside the search, with combined
    correlation at least ``MIN_CORRELATION``, and pinned: every offset ``smallest`` hops or
    more away (beyond the deadband) fits worse by at least ``CONFIDENCE_NATS``, so the
    likelihood-ratio interval lies inside the deadband. The interval counts only each
    pair's voiced frames, in independent frames less the three a correlation spends
    (Fisher's ``n - 3``): around a lone click the talker's silence correlates perfectly
    with the copy's, but that is one event, not evidence for a lag.
    """
    r, n = _correlation(span)
    per_frame = np.log1p(-(np.clip(r, 0.0, 0.999) ** 2)) / 2
    independent = n * HOP_SEC / FRAME_SEC
    fit = (independent * per_frame).sum(axis=-2)
    size = fit.shape[-1]
    best = np.argmin(fit, axis=-1)[..., None]
    at_best = np.take_along_axis(per_frame, best[..., None, :], axis=-1)
    voiced = np.take_along_axis(span[..., 6], best[..., None, :], axis=-1)
    events = np.maximum(voiced * HOP_SEC / FRAME_SEC - 3, 0.0)
    margin = (events * (per_frame - at_best)).sum(axis=-2)
    far = np.abs(np.arange(size) - best) >= smallest
    pinned = np.where(far, margin, np.inf).min(axis=-1, keepdims=True) >= CONFIDENCE_NATS
    best_fit = np.take_along_axis(fit, best, axis=-1)
    total = np.take_along_axis(independent.sum(axis=-2), best, axis=-1)
    with np.errstate(invalid="ignore", divide="ignore"):
        combined = np.sqrt(-np.expm1(2 * best_fit / total))
    valid = (
        (fit == best_fit)
        & (np.nan_to_num(combined) >= MIN_CORRELATION)
        & pinned
        & (best > 0)
        & (best < size - 1)
    )
    return fit, valid


Run = tuple[int, int, int]


def _spans(cum: np.ndarray, smallest: int) -> list[np.ndarray]:
    """``spans[b - 1][a, k]``: the fit of blocks ``[a, b)`` at offset ``k``, inf where invalid.

    Independent of the step cost, so one table serves every cost cross-validation tries.
    """
    spans = []
    for b in range(1, cum.shape[0]):
        fit, valid = _fit(cum[b] - cum[:b], smallest)
        spans.append(np.where(valid, fit, np.inf))
    return spans


def _partition(spans: list[np.ndarray], largest: np.ndarray, step_cost: float) -> list[Run] | None:
    """Blocks split into runs ``(first, end, offset)`` minimising fit plus ``step_cost`` per run.

    A step may be any size its silence holds; whether it is worth applying is
    :func:`_keep_steps`'s call, once each piece is measured against its real neighbours.
    """
    count, size = len(spans), spans[0].shape[1]
    offsets = np.abs(np.subtract.outer(np.arange(size), np.arange(size)))
    # total[b, k]: best cost of blocks [0, b) ending on offset k; entry[b, k]: best cost of
    # blocks [0, b) followed by a step into offset k at block b (0 for b = 0).
    total = np.full((count + 1, size), np.inf)
    entry = np.full((count + 1, size), np.inf)
    start = np.zeros((count + 1, size), dtype=int)
    came = np.zeros((count + 1, size), dtype=int)
    entry[0] = 0.0
    for b in range(1, count + 1):
        options = entry[:b] + spans[b - 1]
        start[b] = np.argmin(options, axis=0)
        total[b] = options[start[b], np.arange(size)] + step_cost
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
    runs: list[Run], cum: np.ndarray, largest: np.ndarray, smallest: int, step_cost: float
) -> list[Run] | None:
    """The best subset of ``runs``' steps where every kept step exceeds the deadband.

    Dropping a step merges its two runs into one piece at that piece's own best offset, and
    each remaining step is judged between the merged pieces either side of it, so a step
    is never rejected against a neighbour that a dropped step created. A kept step is at
    least ``smallest`` hops and fits its silence.
    """
    bounds = [a for a, _b, _k in runs] + [runs[-1][1]]
    m = len(runs)
    lag = np.full((m + 1, m + 1), -1, dtype=int)
    cost = np.full((m + 1, m + 1), np.inf)
    for i in range(m):
        fit, valid = _fit(cum[np.array(bounds[i + 1 :])] - cum[bounds[i]], smallest)
        for j, row, row_fit in zip(range(i + 1, m + 1), valid, fit, strict=True):
            if row.any():
                lag[i, j] = int(np.argmax(row))
                cost[i, j] = float(row_fit[lag[i, j]])
    # best[j, i]: cost of bounds [0, j) whose last piece is (i, j); came[j, i]: the piece's
    # start before it.
    best = np.full((m + 1, m + 1), np.inf)
    came = np.full((m + 1, m + 1), -1, dtype=int)
    best[1:, 0] = cost[0, 1:] + step_cost
    for j in range(2, m + 1):
        for i in range(1, j):
            if not np.isfinite(cost[i, j]):
                continue
            step = np.abs(lag[:i, i] - lag[i, j])
            ok = np.isfinite(best[i, :i]) & (step >= smallest) & (step <= largest[bounds[i]])
            if ok.any():
                before = np.where(ok, best[i, :i], np.inf)
                came[j, i] = int(np.argmin(before))
                best[j, i] = before[came[j, i]] + cost[i, j] + step_cost
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


def _segment(
    cum: np.ndarray,
    spans: list[np.ndarray],
    largest: np.ndarray,
    smallest: int,
    step_cost: float,
) -> list[Run]:
    """Runs at ``step_cost`` (one run at the whole lane's best offset when no step stands)."""
    runs = _partition(spans, largest, step_cost) if np.isfinite(step_cost) else None
    if runs is not None:
        runs = _keep_steps(runs, cum, largest, smallest, step_cost)
    if runs is None:
        fit, _valid = _fit(cum[-1] - cum[0], smallest)
        runs = [(0, cum.shape[0] - 1, int(np.argmin(fit)))]
    return runs


def _step_cost(blocks: np.ndarray, largest: np.ndarray, smallest: int) -> float:
    """The step cost that best predicts held-out speech on this lane (inf: no steps).

    Blocks are dealt to ``FOLDS`` folds in turn. For each fold the lane is segmented on the
    other folds' evidence and scored on that fold's, at each piece's lag (log-likelihood,
    lower is better). Of the costs within ``CONFIDENCE_NATS`` of the best total, the
    largest wins: fewer pieces when the data cannot tell them apart.
    """
    fold = np.arange(blocks.shape[0]) % FOLDS
    candidates = (*STEP_COSTS, np.inf)
    scores = np.zeros(len(candidates))
    for f in range(FOLDS):
        train = np.where((fold == f)[:, None, None, None], 0.0, blocks)
        cum = np.concatenate([np.zeros((1, *blocks.shape[1:])), np.cumsum(train, axis=0)])
        held = np.concatenate([np.zeros((1, *blocks.shape[1:])), np.cumsum(blocks - train, axis=0)])
        spans = _spans(cum, smallest)
        for c, cost in enumerate(candidates):
            for a, b, k in _segment(cum, spans, largest, smallest, cost):
                fit, _valid = _fit(held[b] - held[a], smallest)
                scores[c] += fit[k]
    best = scores.min()
    return max(
        cost
        for cost, score in zip(candidates, scores, strict=True)
        if score <= best + CONFIDENCE_NATS
    )


@dataclass(frozen=True)
class LagSteps:
    """A lane's pieces and the step cost cross-validation chose for it."""

    segments: tuple[LagSegment, ...]
    step_cost: float


def lag_segments(
    source: np.ndarray,
    pairs: Sequence[BleedPair],
    *,
    heard: np.ndarray,
    heard_peak: np.ndarray,
    deadband_sec: float,
) -> LagSteps | None:
    """Piecewise shift of a lane (``source``: its media envelope) from every pair it is in.

    All envelopes are on the ``HOP_SEC`` grid. ``heard`` is the lane's full-band envelope,
    which decides where it is silent: a decode band-limited for lag work hides sibilants
    above its Nyquist (an "s" at -26 dBFS read as -61 dB at 8 kHz on the lab tape).
    ``heard_peak`` is its per-frame sample peak on the same grid, so a step never skips or
    repeats a click whose RMS reads as silence. Each pair is searched around its own
    steady lag, which carries its copy's path delay, and the pieces' steps are common to
    all of them. The first pair anchors the lane on the reference clock, so callers put a
    pair with the reference first. None when no step stands.
    """
    firsts, lasts = _talk_spurts(heard[: source.size], heard_peak)
    if firsts.size < 2 or not pairs:
        return None
    centres = [round(pair.lag_sec / HOP_SEC) for pair in pairs]
    reach = round(SEARCH_SEC / HOP_SEC)
    offsets = np.arange(-reach, reach + 1)
    # Each spurt owns its frames from the middle of the gap before to the middle after.
    owner = np.searchsorted((lasts[:-1] + firsts[1:]) // 2, np.arange(source.size), side="right")
    sums = np.stack(
        [
            _sums(source, pair, owner, firsts.size, centre + offsets)
            for pair, centre in zip(pairs, centres, strict=True)
        ],
        axis=1,
    )
    # Spurts without a dominant frame carry no evidence: fold each into the block before,
    # keeping its gaps as places a step can go.
    evidence = np.flatnonzero(sums[..., 0].max(axis=(1, 2)) > 0)
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
    step_cost = _step_cost(blocks, largest, smallest)
    if not np.isfinite(step_cost):
        return None
    runs = _segment(cum, _spans(cum, smallest), largest, smallest, step_cost)
    if len(runs) == 1:
        return None
    anchor = centres[0]
    segments = []
    for a, b, k in runs:
        span = cum[b] - cum[a]
        _r, n = _correlation(span)
        fit, _valid = _fit(span, smallest)
        frames = float(n[:, k].sum())
        # The correlation one pair with this many frames would need for the fit.
        combined = np.sqrt(-np.expm1(2 * fit[k] / (frames * HOP_SEC / FRAME_SEC)))
        quiet = gap_at[a] * HOP_SEC if a else None
        segments.append(
            LagSegment(
                start_sec=0.0 if quiet is None else float(quiet.mean()),
                shift_sec=float(-(anchor + offsets[k]) * HOP_SEC),
                frames=int(frames),
                correlation=round(float(combined), 3),
                gap_sec=None if quiet is None else (float(quiet[0]), float(quiet[1])),
            )
        )
    return LagSteps(tuple(segments), step_cost)
