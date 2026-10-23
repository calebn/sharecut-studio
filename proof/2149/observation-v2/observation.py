"""Task-local observation reference; no browser, native input, or case qualification."""

from __future__ import annotations

import asyncio
import math
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import asdict, dataclass
from itertools import pairwise

SLOTS = 9
SLOT_MS = 250
MIN_COVERAGE_MS = 2000
HARD_END_MS = 2500
MAX_GAP_MS = 400
FINAL_SPAN_MS = 1000
MIN_FINAL_SAMPLES = 5
SCALE_EPSILON = 1e-6


@dataclass(frozen=True)
class Sample:
    slot: int
    at_ms: float
    scale: float


@dataclass(frozen=True)
class Verdict:
    valid: bool
    reasons: tuple[str, ...]
    any_zoom: bool
    coverage_ms: float | None
    max_gap_ms: float | None
    final_indices: tuple[int, ...]
    final_span_ms: float | None
    final_scale_range: float | None


def validate(samples: Sequence[Sample]) -> Verdict:
    """Validate fresh observations only; this never reclassifies historical runs.

    at_ms must share one actual monotonic clock. The first actual sample defines
    t0; scheduled deadlines cannot substitute for observed timestamps.
    any_zoom is an observed signal even when validity fails, not a qualified case.
    """
    reasons = []
    zoom = any(math.isfinite(s.scale) and s.scale > 1 + SCALE_EPSILON for s in samples)
    if len(samples) != SLOTS:
        reasons.append("expected-nine-actual-samples")
    if [s.slot for s in samples] != list(range(SLOTS)):
        reasons.append("missing-duplicate-or-out-of-order-slot")
    if not samples or any(not math.isfinite(s.at_ms) for s in samples):
        return Verdict(
            False, (*reasons, "nonfinite-or-missing-time"), zoom, None, None, (), None, None
        )
    if any(not math.isfinite(s.scale) or s.scale <= 0 for s in samples):
        reasons.append("scale-must-be-finite-positive")
    gaps = [b.at_ms - a.at_ms for a, b in pairwise(samples)]
    if any(gap <= 0 for gap in gaps):
        reasons.append("timestamps-not-strictly-increasing")
    coverage = samples[-1].at_ms - samples[0].at_ms
    maximum_gap = max(gaps, default=0)
    if coverage < MIN_COVERAGE_MS:
        reasons.append("coverage-below-2000ms")
    if coverage >= HARD_END_MS:
        reasons.append("hard-end-at-or-after-2500ms")
    if maximum_gap > MAX_GAP_MS:
        reasons.append("adjacent-gap-above-400ms")
    # Slot zero is actual t0; no later sample may precede its absolute slot.
    if any(s.at_ms - samples[0].at_ms < s.slot * SLOT_MS for s in samples):
        reasons.append("sample-before-absolute-slot")
    final_indices = ()
    final_span = None
    scale_range = None
    if not any(gap <= 0 for gap in gaps):
        cutoff = samples[-1].at_ms - FINAL_SPAN_MS
        predecessors = [i for i, sample in enumerate(samples) if sample.at_ms <= cutoff]
        if not predecessors:
            reasons.append("missing-left-bracket")
        else:
            left = predecessors[-1]
            final_indices = tuple(range(left, len(samples)))
            final = samples[left:]
            final_span = final[-1].at_ms - final[0].at_ms
            if final_span < FINAL_SPAN_MS:
                reasons.append("bracket-span-below-1000ms")
            if len(final) < MIN_FINAL_SAMPLES:
                reasons.append("fewer-than-five-bracketed-samples")
            if all(math.isfinite(s.scale) and s.scale > 0 for s in final):
                scale_range = max(s.scale for s in final) - min(s.scale for s in final)
                if scale_range > SCALE_EPSILON:
                    reasons.append("final-scale-not-stable")
    return Verdict(
        not reasons,
        tuple(reasons),
        zoom,
        coverage,
        maximum_gap,
        final_indices,
        final_span,
        scale_range,
    )


@dataclass(frozen=True)
class Collection:
    samples: tuple[Sample, ...]
    stop_reason: str
    slot_deadlines_ms: tuple[float, ...]


async def collect_absolute(read_scale: Callable[[int], Awaitable[float]]) -> Collection:
    """Reference scheduler; callback completion timestamps are real loop.time().

    Reader zero has its own bounded initial-read timeout. Observation t0 starts
    only at its actual completion. Later reads share ONE hard deadline, never a
    refreshed per-read timeout. The callback is a fixture here, not a Mac API.
    """
    loop = asyncio.get_running_loop()
    try:
        first = await asyncio.wait_for(read_scale(0), timeout=HARD_END_MS / 1000)
    except TimeoutError:
        return Collection((), "initial-read-timeout", ())
    t0 = loop.time()
    samples = [Sample(0, t0 * 1000, first)]
    deadlines = tuple(i * SLOT_MS for i in range(SLOTS))
    hard_end = t0 + HARD_END_MS / 1000
    try:
        async with asyncio.timeout_at(hard_end):
            for slot in range(1, SLOTS):
                deadline = t0 + slot * SLOT_MS / 1000
                while loop.time() < deadline:
                    await asyncio.sleep(deadline - loop.time())
                if loop.time() >= hard_end:
                    return Collection(tuple(samples), "hard-end", deadlines)
                value = await read_scale(slot)
                at = loop.time()
                if at >= hard_end:
                    return Collection(tuple(samples), "hard-end", deadlines)
                samples.append(Sample(slot, at * 1000, value))
    except TimeoutError:
        return Collection(tuple(samples), "hard-end", deadlines)
    return Collection(tuple(samples), "nine-samples", deadlines)


def report(collection: Collection) -> dict:
    return {"collection": asdict(collection), "verdict": asdict(validate(collection.samples))}
