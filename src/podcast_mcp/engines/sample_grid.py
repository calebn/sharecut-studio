"""Which native samples a clip piece plays, and where, on a reader's sample grid (#1258).

Every reader that turns clips into samples (the raw timeline projection, the placed lane
read, the peer guard's removed-sample spans) asks this module, so they cannot disagree on
the rounding. At a reader's rate ``r`` a piece plays source samples
``[round(source_start * r), round(source_end * r))``: its edges round in the source clock,
as the renderer's per-piece trim does, so a piece and the piece that starts where it ends
share one real boundary and neither loses nor repeats a sample. Its first sample lands on
timeline sample ``round(timeline_start * r)``, except that a piece whose timeline start
meets the previous piece's end is laid straight after it when that is within one sample of
its own rounded start: pieces the render joins back to back (a ripple closed the gap) leave
no overlap and no hole, and no piece drifts more than a sample from the timeline.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

_CLOCK_EPS_SEC = 1e-6


@dataclass(frozen=True)
class Piece:
    """One stretch of a recording with finite bounds."""

    source_start: float
    source_end: float
    timeline_start: float
    timeline_end: float


@dataclass(frozen=True)
class PieceCells:
    """Where a piece's samples play: ``count`` samples from source sample ``first`` on
    timeline samples ``dest`` onward."""

    dest: int
    first: int
    count: int

    @property
    def stop(self) -> int:
        return self.dest + self.count

    def clip_to(self, lo: int, hi: int) -> tuple[int, int] | None:
        """The timeline samples ``[k0, k1)`` of ``[lo, hi)`` this piece plays, if any."""
        k0, k1 = max(self.dest, lo), min(self.stop, hi)
        return (k0, k1) if k1 > k0 else None

    def source_of(self, timeline_sample: int) -> int:
        return self.first + timeline_sample - self.dest


def lay_out(pieces: Sequence[Piece], rate: int) -> list[PieceCells]:
    """The sample cells of ``pieces`` (in timeline order) at ``rate``."""
    cells: list[PieceCells] = []
    stops: dict[int, int] = {}
    for piece in pieces:
        first = round(piece.source_start * rate)
        count = max(0, round(piece.source_end * rate) - first)
        dest = round(piece.timeline_start * rate)
        joined = _stop_meeting(stops, piece.timeline_start)
        if joined is not None and abs(joined - dest) <= 1:
            dest = joined
        cells.append(PieceCells(dest, first, count))
        if math.isfinite(piece.timeline_end):
            stops[_tick(piece.timeline_end)] = dest + count
    return cells


def _tick(seconds: float) -> int:
    return round(seconds / _CLOCK_EPS_SEC)


def _stop_meeting(stops: dict[int, int], timeline_start: float) -> int | None:
    """The timeline sample where the latest piece ending at ``timeline_start`` stops."""
    tick = _tick(timeline_start)
    return next((stops[t] for t in (tick, tick - 1, tick + 1) if t in stops), None)
