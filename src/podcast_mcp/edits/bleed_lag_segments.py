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
are kept, and each spurt is scored on its own correlation: a run of spurts fits as the sum
of its spurts' log-likelihoods, and pairs add the same way. One correlation over a whole
run would also score how the spurts' levels line up between the tracks, which follows the
talker's loudness and the room, not the lane's timing, so a phrase whose level relation
matched the speech before a pause rode that piece at the wrong lag.

A segment is a run of spurts at its own best lag, with correlation at least
``MIN_CORRELATION``, the peak inside the search, and enough evidence to pin it: every lag
beyond the deadband fits worse by ``CONFIDENCE_NATS`` (its likelihood-ratio interval lies
inside the deadband), counted over the talker's own voiced frames less the three a
correlation spends. A short phrase with a sharp peak passes; a long stretch with a flat
correlation does not, and neither does a lone click, whose surrounding silence correlates
perfectly with the copy's. The floor scales with the evidence, not with a frame count.
Dynamic programming picks the segments that minimise ``sum(w / 2 * log(1 - r^2))`` (``w``
in independent frames, ``FRAME_SEC`` apart, less three per spurt) plus a step cost per
segment, where the widest silence between neighbours holds the step plus ``EDGE_SEC`` on
each side. A second pass then keeps the best subset of those steps in which every step
exceeds the deadband, measuring each step between the merged pieces either side of it: two
neighbours inside the deadband are one piece, and the step before them is judged against
that piece. Last, each step moves into the widest silence among the positions its
evidence cannot tell apart.

The step cost is chosen per lane by cross-validation: each spurt's frames are dealt to
``FOLDS`` folds in ``CHUNK_SEC`` chunks, so every spurt, a lone phrase included, keeps most
of its evidence in training. Each fold is predicted from pieces fitted on the others at each
of the ``STEP_COSTS`` and with no steps. Costs whose held-out fit is worse than the best by
more than ``CONFIDENCE_Z`` standard errors are ruled out, and of the rest the smallest
wins, since every piece it keeps is pinned by its own evidence.

Each pair is searched ``SEARCH_SEC`` either side of its steady lag. Speech envelopes
correlate again one syllable away (about 200 ms), so a wider search lets a short stretch
lock onto a neighbouring syllable. Everything is measured from the lane's media and the
other tracks, never from where the pieces sit, so a re-run finds the same segments.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from podcast_mcp.edits.bleed_latency import (
    DOMINANCE_DB,
    FRAME_SEC,
    HOP_SEC,
    OPEN_DB,
    LatencySettings,
    measure_pair,
)
from podcast_mcp.engines.envelope_lag import LEVEL_FLOOR_DB, MIN_CORRELATION

MIN_GAP_SEC = 0.06
EDGE_SEC = 0.02
# A step skips or repeats only audio whose 30 ms RMS is under OPEN_DB and whose every
# sample peaks under this: 10 dB over the RMS gate, about the crest of a noise floor
# sitting at the gate, so a click the RMS averages away still counts as sound.
SKIP_PEAK_DB = OPEN_DB + 10.0
SEARCH_SEC = 0.1
# The 95% normal quantile, and half its square (the 95% chi-square(1) quantile over two):
# how far a lag must fit worse, in nats, before a piece's evidence rules it out.
CONFIDENCE_Z = 1.96
CONFIDENCE_NATS = CONFIDENCE_Z**2 / 2
# Step costs (nats) cross-validation chooses from, per lane, over FOLDS interleaved folds
# that deal frames in chunks of about a syllable, where speech envelopes decorrelate.
STEP_COSTS = (0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0)
FOLDS = 5
CHUNK_SEC = 2 * SEARCH_SEC
_EPS = float(np.finfo(np.float64).eps)


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
    ``f``): the lane's latency plus the copy's path delay (:func:`steady_lag`).
    """

    other: np.ndarray
    lane_talks: bool
    lag_sec: float


def steady_lag(
    source: np.ndarray,
    other: np.ndarray,
    *,
    lane_talks: bool,
    near_sec: float,
    settings: LatencySettings,
) -> float | None:
    """A pair's steady lag in lane source time, from the lane's media; None when it scatters.

    The median of the pair's window lags (:func:`measure_pair`) with the windows on the
    lane's source time, so where the lane's pieces sit cannot move it and a re-run finds
    the same pieces. ``near_sec`` only centres each window's search.
    """
    near = round(near_sec / HOP_SEC)
    placed = np.concatenate([np.full(near, LEVEL_FLOOR_DB), other]) if near >= 0 else other[-near:]
    talker, copy = (source, placed) if lane_talks else (placed, source)
    pair = measure_pair(
        talker,
        copy,
        source_track_id="talker",
        mic_track_id="copy",
        tolerance_sec=settings.tolerance_sec,
        deadband_sec=settings.deadband_sec,
    )
    if pair.reason != "consistent" or pair.lag_sec is None:
        return None
    return near * HOP_SEC + (pair.lag_sec if lane_talks else -pair.lag_sec)


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
    """``[unit, fold, lag, (n, Σx, Σy, Σxx, Σyy, Σxy, voiced)]``: x the other track, y the lane.

    Units go by lane frame. Folds deal the other track's frames in ``CHUNK_SEC`` chunks.
    ``voiced`` counts the frames where the talker itself is open at that lag; the rest pair
    the copy with the talker's silence around a word.
    """
    sums = np.zeros((units, FOLDS, lags.size, 7))
    frames = _frames(source, pair, lags)
    fold = (frames // round(CHUNK_SEC / HOP_SEC)) % FOLDS
    for j, lag in enumerate(lags):
        inside = (frames + lag >= 0) & (frames + lag < source.size)
        f = frames[inside]
        x, y = pair.other[f], source[f + lag]
        key = owner[f + lag] * FOLDS + fold[inside]
        voiced = (y if pair.lane_talks else x) > OPEN_DB
        for col, value in enumerate(
            (np.ones_like(x), x, y, x * x, y * y, x * y, voiced.astype(float))
        ):
            sums[:, :, j, col] = np.bincount(key, weights=value, minlength=units * FOLDS).reshape(
                units, FOLDS
            )
    return sums


def _correlation(sums: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Correlation and frame count per lag (the last axis of ``sums`` holds the sums).

    A series whose centred variance ``Σxx - Σx² / n`` the float64 sums cannot resolve has
    nothing to correlate: the correlation is 0, which adds no evidence. The subtraction
    loses about ``n`` half-ulps of ``Σxx`` accumulating ``n`` terms, so a variance at or
    under ``n * EPS * Σxx`` is that rounding, not signal. It also covers the envelope's own
    quantization: a float32 sample is exact to 2^-23, 7e-7 dB, and a series that varies by
    that much has a relative variance of 1e-16 at the floor, under ``n * EPS`` for any
    ``n``. A copy gated to ``LEVEL_FLOOR_DB`` for a whole spurt is the common case: scored
    by its rounding noise it read as a perfect (or perfectly opposite) correlation.
    """
    n, sx, sy, sxx, syy, sxy = np.moveaxis(sums[..., :6], -1, 0)
    with np.errstate(invalid="ignore", divide="ignore"):
        var_x, var_y = sxx - sx * sx / n, syy - sy * sy / n
        resolved = (var_x > n * _EPS * sxx) & (var_y > n * _EPS * syy)
        r = (sxy - sx * sy / n) / np.sqrt(np.where(resolved, var_x * var_y, 1.0))
    return np.where(resolved, r, 0.0), n


@dataclass(frozen=True)
class _Evidence:
    """Each block's own fit per lag offset, summed over pairs, cumulative over blocks.

    Row ``b`` holds blocks ``[0, b)``, so a run ``[a, b)`` is ``row[b] - row[a]``. A block's
    fit is ``w / 2 * log(1 - r^2)`` (lower is better) with ``r`` its own correlation and
    ``w`` its independent frames (``FRAME_SEC`` apart) less the three a correlation spends.
    ``fit`` counts every frame where the talker out-levels the copy; ``voiced`` counts only
    those where the talker itself is open, since around a lone click the talker's silence
    correlates perfectly with the copy's. ``weight`` sums ``fit``'s ``w`` and ``frames`` the
    raw frame count.
    """

    fit: np.ndarray
    voiced: np.ndarray
    weight: np.ndarray
    frames: np.ndarray

    @classmethod
    def of(cls, blocks: np.ndarray) -> _Evidence:
        """From per-block sums ``[block, pair, offset, sums]``."""
        r, n = _correlation(blocks)
        per_frame = np.log1p(-(np.clip(r, 0.0, 0.999) ** 2)) / 2
        weight = np.maximum(n * HOP_SEC / FRAME_SEC - 3, 0.0)
        voiced = np.maximum(blocks[..., 6] * HOP_SEC / FRAME_SEC - 3, 0.0)

        def cumulative(per_block: np.ndarray) -> np.ndarray:
            rows = per_block.sum(axis=1)
            return np.concatenate([np.zeros((1, rows.shape[-1])), np.cumsum(rows, axis=0)])

        return cls(
            fit=cumulative(weight * per_frame),
            voiced=cumulative(voiced * per_frame),
            weight=cumulative(weight),
            frames=cumulative(n),
        )

    @property
    def count(self) -> int:
        return self.fit.shape[0] - 1

    def best(
        self, a: np.ndarray | int, b: np.ndarray | int, smallest: int
    ) -> tuple[np.ndarray, np.ndarray]:
        """Runs ``[a, b)``: each one's best offset and whether a piece may sit there.

        A piece sits at its own best offset, inside the search (the peak, not the edge), with
        combined correlation at least ``MIN_CORRELATION``, and pinned: every offset
        ``smallest`` hops or more away (beyond the deadband) fits its voiced evidence worse
        by at least ``CONFIDENCE_NATS``, so its likelihood-ratio interval lies inside the
        deadband.
        """
        fit = np.atleast_2d(self.fit[b] - self.fit[a])
        voiced = np.atleast_2d(self.voiced[b] - self.voiced[a])
        weight = np.atleast_2d(self.weight[b] - self.weight[a])
        rows, offsets = np.arange(fit.shape[0]), np.arange(fit.shape[1])
        best = np.argmin(fit, axis=1)
        with np.errstate(invalid="ignore", divide="ignore"):
            combined = np.nan_to_num(np.sqrt(-np.expm1(2 * fit[rows, best] / weight[rows, best])))
        far = np.abs(offsets - best[:, None]) >= smallest
        margin = np.where(far, voiced - voiced[rows, best][:, None], np.inf).min(axis=1)
        valid = (
            (combined >= MIN_CORRELATION)
            & (margin >= CONFIDENCE_NATS)
            & (best > 0)
            & (best < offsets.size - 1)
        )
        if np.ndim(a) == 0 and np.ndim(b) == 0:
            return best[0], valid[0]
        return best, valid


Run = tuple[int, int, int]


def _spans(evidence: _Evidence, smallest: int) -> list[np.ndarray]:
    """``spans[b - 1][a, k]``: the fit of blocks ``[a, b)`` at offset ``k``, inf where invalid.

    Independent of the step cost, so one table serves every cost cross-validation tries.
    """
    spans = []
    for b in range(1, evidence.count + 1):
        a = np.arange(b)
        best, valid = evidence.best(a, b, smallest)
        span = np.full((b, evidence.fit.shape[1]), np.inf)
        span[a[valid], best[valid]] = (evidence.fit[b] - evidence.fit[a])[a[valid], best[valid]]
        spans.append(span)
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
    runs: list[Run], evidence: _Evidence, largest: np.ndarray, smallest: int, step_cost: float
) -> list[Run] | None:
    """The best subset of ``runs``' steps where every kept step exceeds the deadband.

    Dropping a step merges its two runs into one piece at that piece's own best offset, and
    each remaining step is judged between the merged pieces either side of it, so a step
    is never rejected against a neighbour that a dropped step created. A kept step is at
    least ``smallest`` hops and fits its silence.
    """
    bounds = np.array([a for a, _b, _k in runs] + [runs[-1][1]])
    m = len(runs)
    lag = np.full((m + 1, m + 1), -1, dtype=int)
    cost = np.full((m + 1, m + 1), np.inf)
    for i in range(m):
        best, valid = evidence.best(bounds[i], bounds[i + 1 :], smallest)
        fit = evidence.fit[bounds[i + 1 :]] - evidence.fit[bounds[i]]
        for row in np.flatnonzero(valid):
            lag[i, i + 1 + row] = best[row]
            cost[i, i + 1 + row] = fit[row, best[row]]
    # best_cost[j, i]: cost of bounds [0, j) whose last piece is (i, j); came[j, i]: the
    # piece's start before it.
    best_cost = np.full((m + 1, m + 1), np.inf)
    came = np.full((m + 1, m + 1), -1, dtype=int)
    best_cost[1:, 0] = cost[0, 1:] + step_cost
    for j in range(2, m + 1):
        for i in range(1, j):
            if not np.isfinite(cost[i, j]):
                continue
            step = np.abs(lag[:i, i] - lag[i, j])
            ok = np.isfinite(best_cost[i, :i]) & (step >= smallest) & (step <= largest[bounds[i]])
            if ok.any():
                options = np.where(ok, best_cost[i, :i], np.inf)
                came[j, i] = int(np.argmin(options))
                best_cost[j, i] = options[came[j, i]] + cost[i, j] + step_cost
    i = int(np.argmin(best_cost[m]))
    if not np.isfinite(best_cost[m, i]):
        return None
    kept: list[Run] = []
    j = m
    while True:
        kept.append((int(bounds[i]), int(bounds[j]), int(lag[i, j])))
        if i == 0:
            return kept[::-1]
        i, j = int(came[j, i]), i


def _place_steps(runs: list[Run], evidence: _Evidence, largest: np.ndarray) -> list[Run]:
    """Each step moved into the widest silence its evidence cannot rule out.

    Moving a step across blocks plays them at the other side's lag. Where that changes
    their fit by less than ``CONFIDENCE_NATS``, together and one by one, the evidence cannot
    tell the positions apart, and the step goes in the widest of their silences that holds
    it: a jitter buffer re-times a track when its talker resumes after a pause.
    """
    fit = np.diff(evidence.fit, axis=0)
    placed = list(runs)
    for n in range(1, len(placed)):
        (a, s, before), (_s, b, after) = placed[n - 1], placed[n]
        # lean[t]: how much worse block t fits on the right of the step than on the left.
        lean = fit[:, after] - fit[:, before]
        options = [s]
        for t in range(s - 1, a, -1):
            if max(abs(lean[t]), abs(lean[t:s].sum())) >= CONFIDENCE_NATS:
                break
            options.append(t)
        for t in range(s + 1, b):
            if max(abs(lean[t - 1]), abs(lean[s:t].sum())) >= CONFIDENCE_NATS:
                break
            options.append(t)
        holds = [t for t in sorted(options) if largest[t] >= abs(before - after)]
        at = max(holds, key=lambda t: largest[t]) if holds else s
        placed[n - 1], placed[n] = (a, at, before), (at, b, after)
    return placed


def _segment(
    evidence: _Evidence,
    spans: list[np.ndarray],
    largest: np.ndarray,
    smallest: int,
    step_cost: float,
) -> list[Run]:
    """Runs at ``step_cost`` (one run at the whole lane's best offset when no step stands)."""
    runs = _partition(spans, largest, step_cost) if np.isfinite(step_cost) else None
    if runs is not None:
        runs = _keep_steps(runs, evidence, largest, smallest, step_cost)
    if runs is None:
        best, _valid = evidence.best(0, evidence.count, smallest)
        return [(0, evidence.count, int(best))]
    return _place_steps(runs, evidence, largest)


def _step_cost(folds: np.ndarray, largest: np.ndarray, smallest: int) -> float:
    """The step cost held-out speech on this lane supports (inf: no steps).

    ``folds`` is ``[block, fold, pair, offset, sums]``. For each fold the lane is segmented
    on the other folds' frames, so every block, a lone phrase included, keeps most of its
    evidence, and scored on that fold's frames, each block at its piece's lag. A cost whose
    held-out fit is worse than the best by more than ``CONFIDENCE_Z`` standard errors of
    the paired per-block differences is ruled out, and of the rest the smallest wins:
    every piece it keeps is pinned by its own evidence, and a dearer cost only merges
    pinned pieces the held-out speech cannot tell apart from them.
    """
    candidates = (*STEP_COSTS, np.inf)
    total = folds.sum(axis=1)
    held = np.zeros((len(candidates), folds.shape[0]))
    for f in range(FOLDS):
        train = _Evidence.of(total - folds[:, f])
        test = np.diff(_Evidence.of(folds[:, f]).fit, axis=0)
        spans = _spans(train, smallest)
        for c, cost in enumerate(candidates):
            for a, b, k in _segment(train, spans, largest, smallest, cost):
                held[c, a:b] += test[a:b, k]
    worse = held - held[int(np.argmin(held.sum(axis=1)))]
    noise = CONFIDENCE_Z * np.sqrt(worse.shape[1]) * worse.std(axis=1)
    return min(
        cost
        for cost, excess, spread in zip(candidates, worse.sum(axis=1), noise, strict=True)
        if excess <= spread
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
        axis=2,
    )
    # Spurts without a dominant frame carry no evidence: fold each into the block before,
    # keeping its gaps as places a step can go.
    evidence = np.flatnonzero(sums[..., 0].sum(axis=1).max(axis=(1, 2)) > 0)
    if evidence.size < 2:
        return None
    folds = np.add.reduceat(sums, evidence, axis=0)
    folds[0] += sums[: evidence[0]].sum(axis=0)
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
    step_cost = _step_cost(folds, largest, smallest)
    if not np.isfinite(step_cost):
        return None
    lane = _Evidence.of(folds.sum(axis=1))
    runs = _segment(lane, _spans(lane, smallest), largest, smallest, step_cost)
    if len(runs) == 1:
        return None
    anchor = centres[0]
    segments = []
    for a, b, k in runs:
        fit = lane.fit[b, k] - lane.fit[a, k]
        weight = lane.weight[b, k] - lane.weight[a, k]
        quiet = gap_at[a] * HOP_SEC if a else None
        segments.append(
            LagSegment(
                start_sec=0.0 if quiet is None else float(quiet.mean()),
                shift_sec=float(-(anchor + offsets[k]) * HOP_SEC),
                frames=int(lane.frames[b, k] - lane.frames[a, k]),
                correlation=round(float(np.sqrt(-np.expm1(2 * fit / weight))), 3),
                gap_sec=None if quiet is None else (float(quiet[0]), float(quiet[1])),
            )
        )
    return LagSteps(tuple(segments), step_cost)
