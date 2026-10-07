"""Semantic time types for the two project clocks.

The project has exactly two clocks (see docs/episode-format-v2.md):

- ``SourceSec``: seconds into a track's raw media file (``track.media.path``).
  All *stored* times use this clock: ``TranscriptWord.start/end``,
  ``EditDecision.start/end``, ``CombinedUtterance.start/end``.
- ``TimelineSec``: seconds on the edited session/deliverable clock - rendered
  stems, premix, mastered audio, and exports all play on this clock.

``timeline.clips`` is the only bridge between the clocks, and
``podcast_mcp.engines.session_timeline.SessionTimeline`` is the only module
allowed to do clip time math. Annotate time parameters with these types so
mypy flags mixed-clock call sites.
"""

from __future__ import annotations

from typing import NewType

SourceSec = NewType("SourceSec", float)
TimelineSec = NewType("TimelineSec", float)


def clock_label(sec: float | None) -> str:
    """``m:ss.s`` (``h:mm:ss.s`` past an hour) for people; ``?`` when unknown."""
    if sec is None:
        return "?"
    s = max(0.0, float(sec))
    m = int(s // 60)
    rem = s - m * 60
    if m >= 60:
        return f"{m // 60}:{m % 60:02d}:{rem:04.1f}"
    return f"{m}:{rem:04.1f}"
