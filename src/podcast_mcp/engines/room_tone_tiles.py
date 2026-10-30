"""Where the repeats of a room-tone span start when it fills a longer gap.

A span shorter than its gap is played again and again. Butt-splicing repeats that all
restart at the span's start puts a seam on a fixed period. Here every repeat reads its own
stretch of an inset of the span, joined to the next by a blend whose borrowed audio stays
inside the span, so a cough just outside a recorded bed is never read. The offsets are a
function of the span and the seed position alone: a preview and the real render pick alike.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

CROSSFADE_REACH_SEC = 0.02
CROSSFADE_MS = round(2 * CROSSFADE_REACH_SEC * 1000)
MIN_TILE_SEC = 0.5
TILE_FRACTION = 0.75
_GOLDEN = (math.sqrt(5.0) - 1.0) / 2.0
_HASH_MULTIPLIER = 2654435761
_HASH_MODULUS = 1 << 32
_FIT_EPS_SEC = 1e-6
_SLIVER_SEC = 0.01


@dataclass(frozen=True)
class Tile:
    """``length`` seconds of the span read from ``source_start``.

    ``reach_in`` and ``reach_out`` are the seconds the join to the previous and the next
    tile borrows from the audio around it; both are zero when the tiles are butt-spliced.
    """

    source_start: float
    length: float
    reach_in: float = 0.0
    reach_out: float = 0.0


def tile_span(
    span_start: float, span_end: float, gap_sec: float, seed_sec: float
) -> tuple[Tile, ...]:
    """The tiles that fill ``gap_sec`` from ``[span_start, span_end)``.

    A gap the span covers is one tile from the span's start. A longer gap takes equal
    tiles from an inset of the span, one per evenly spaced slot so the span is replayed no
    more than the gap forces, visited in an order derived from ``seed_sec`` and blended at
    its joins. A span too short to inset is butt-spliced from its
    start.
    """
    piece = span_end - span_start
    if gap_sec <= 0 or piece <= 0:
        return ()
    if piece >= gap_sec - _FIT_EPS_SEC:
        return (Tile(span_start, gap_sec),)
    inner = piece - 2 * CROSSFADE_REACH_SEC
    if inner < MIN_TILE_SEC / TILE_FRACTION:
        return _butt(span_start, piece, gap_sec)
    count = math.ceil(gap_sec / (inner * TILE_FRACTION) - _FIT_EPS_SEC)
    length = gap_sec / count
    if length < MIN_TILE_SEC:
        return _butt(span_start, piece, gap_sec)
    low = span_start + CROSSFADE_REACH_SEC
    high = low + inner - length
    stride = (high - low) / (count - 1)
    step = _slot_step(count)
    first = int(_seed_fraction(seed_sec) * count)
    starts: list[float] = []
    for index in range(count):
        start = low + ((first + index * step) % count) * stride
        if starts:
            behind = start - (starts[-1] + length)
            if 0 < behind < 2 * CROSSFADE_REACH_SEC:
                joined = starts[-1] + length
                start = joined if joined <= high else low
        starts.append(start)
    return tuple(
        Tile(
            start,
            length,
            CROSSFADE_REACH_SEC if index else 0.0,
            CROSSFADE_REACH_SEC if index + 1 < count else 0.0,
        )
        for index, start in enumerate(starts)
    )


def _butt(span_start: float, piece: float, gap_sec: float) -> tuple[Tile, ...]:
    lengths: list[float] = []
    while sum(lengths) < gap_sec - _FIT_EPS_SEC:
        lengths.append(min(piece, gap_sec - sum(lengths)))
    if len(lengths) > 1 and lengths[-1] < _SLIVER_SEC:
        lengths[-2:] = [(lengths[-2] + lengths[-1]) / 2] * 2
    return tuple(Tile(span_start, length) for length in lengths)


def _slot_step(count: int) -> int:
    near = max(1, min(count - 1, round(_GOLDEN * count)))
    for reach in range(count):
        for step in (near - reach, near + reach):
            if 1 <= step < count and math.gcd(step, count) == 1:
                return step
    return 1


def _seed_fraction(seed_sec: float) -> float:
    key = round(seed_sec * 1000.0)
    return ((key * _HASH_MULTIPLIER) % _HASH_MODULUS) / _HASH_MODULUS
