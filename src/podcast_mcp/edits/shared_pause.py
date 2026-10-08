"""One pause trim per stretch of shared air (#1055).

A session ripple removes the same window of session time from every dialogue track, and
the trim is judged on all of them by one rule (``pause_air_span`` in ``breath_detect``),
so two tracks that are quiet over the same stretch propose the same trim: each from its
own track's pause, at its own source seconds. The reviewer decides that cut once.

A twin is dropped only when the trim that stays covers it and protects everything it
protected: the stays-trim lies over the whole of the dropped one's span, and none of the
sounds the dropped one had to leave whole lies inside the stays-trim. Anything else is a
different cut and both stay. Losing air is the safe direction; keeping a trim that
removes a sound its twin kept is not, so the choice is never made on length alone.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from podcast_mcp.edits.audio_cache import LEVEL_FRAME_SEC
from podcast_mcp.engines.session_timeline import SessionTimeline
from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.source_spans import source_span_timeline_bounds

# Two tracks' 10 ms frame grids sit at arbitrary offsets in the session, so the same stretch
# of air found on each can differ by up to one frame at either edge.
GRID_SLACK_SEC = LEVEL_FRAME_SEC
# Clock arithmetic below a microsecond is rounding, not a different instant.
_EPS_SEC = 1e-6


@dataclass(frozen=True)
class PauseClaim:
    """A session pause trim: its span in ``track_id``'s source seconds, and the sounds it
    left whole because they must stay (session seconds)."""

    track_id: str
    start: float
    end: float
    kept: tuple[tuple[float, float], ...] = ()


@dataclass(frozen=True)
class _Placed:
    """A claim with its span on the session clock."""

    index: int
    claim: PauseClaim
    lo: float
    hi: float

    def stands_for(self, twin: _Placed) -> bool:
        """Whether this trim lies over all of ``twin`` and over none of the sounds ``twin``
        left whole, on another track."""
        if self.claim.track_id == twin.claim.track_id:
            return False
        if twin.lo < self.lo - GRID_SLACK_SEC or twin.hi > self.hi + GRID_SLACK_SEC:
            return False
        return not any(
            a < self.hi - _EPS_SEC and self.lo + _EPS_SEC < b for a, b in twin.claim.kept
        )


def shared_pause_twins(project: EpisodeProject, claims: Sequence[PauseClaim | None]) -> set[int]:
    """The indices of ``claims`` that duplicate a longer trim on another track.

    ``None`` entries are not session pause trims and are left alone. The longest trims
    are considered first (the earliest of equals), so a trim is dropped only for one that
    stays.
    """
    timeline = SessionTimeline(project)
    placed: list[_Placed] = []
    for index, claim in enumerate(claims):
        if claim is None:
            continue
        lo, hi = source_span_timeline_bounds(timeline, claim.track_id, claim.start, claim.end)
        if lo is not None and hi is not None:
            placed.append(_Placed(index, claim, lo, hi))
    staying: list[_Placed] = []
    dropped: set[int] = set()
    for twin in sorted(placed, key=lambda p: p.lo - p.hi):
        if any(kept.stands_for(twin) for kept in staying):
            dropped.add(twin.index)
        else:
            staying.append(twin)
    return dropped
