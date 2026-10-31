"""A clip with a timing map as the ordinary clips the renderer lays out (#2858, umbrella #1089).

Each virtual piece of a mapped clip becomes a shell copy that keeps the parent's id and plays
one constant shift. The inner joins get the declick micro-fade the split pieces they replace had
(``join_micro_fade_ms``); the parent's fades and join mode stay on the outer edges. A positive
step leaves a hole between two shells, returned so the renderer can fill it. Shells are never
persisted.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import pairwise

from podcast_mcp.config.defaults import DEFAULT_MICRO_FADE_MS
from podcast_mcp.models import Clip, ClipJoinMode


@dataclass(frozen=True)
class TimingHole:
    """The timeline span a positive step leaves between ``left`` and ``right``."""

    parent: Clip
    left: Clip
    right: Clip

    @property
    def start(self) -> float:
        return self.left.timeline_end

    @property
    def end(self) -> float:
        return self.right.timeline_start


def expand_timed_clips(
    clips: list[Clip], *, micro_fade_ms: int = DEFAULT_MICRO_FADE_MS
) -> tuple[list[Clip], dict[int, TimingHole]]:
    """``clips`` with each mapped clip replaced by its piece shells, and the holes by the index
    of the shell on their left. A list without a mapped clip comes back as the same object."""
    if all(clip.timing is None for clip in clips):
        return clips, {}
    expanded: list[Clip] = []
    holes: dict[int, TimingHole] = {}
    for clip in clips:
        if clip.timing is None:
            expanded.append(clip)
            continue
        pieces = clip.virtual_pieces()
        shells = [
            clip.model_copy(
                update={
                    "timing": None,
                    "source_start": src_a,
                    "source_end": src_b,
                    "timeline_start": tl_a,
                    "fade_in_ms": clip.fade_in_ms if index == 0 else micro_fade_ms,
                    "fade_out_ms": clip.fade_out_ms if index + 1 == len(pieces) else micro_fade_ms,
                    "join_in_mode": clip.join_in_mode if index == 0 else ClipJoinMode.FADE,
                }
            )
            for index, (src_a, src_b, tl_a) in enumerate(pieces)
        ]
        for offset, (left, right) in enumerate(pairwise(shells)):
            if right.timeline_start > left.timeline_end:
                holes[len(expanded) + offset] = TimingHole(clip, left, right)
        expanded.extend(shells)
    return expanded, holes
