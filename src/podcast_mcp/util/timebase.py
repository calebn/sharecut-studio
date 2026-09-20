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
