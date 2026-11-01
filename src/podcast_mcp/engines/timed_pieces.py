"""A clip with a timing map as the ordinary clips the renderer lays out (#2858, umbrella #1089)."""

from __future__ import annotations

import math
from dataclasses import dataclass
from itertools import pairwise

from podcast_mcp.config.defaults import DEFAULT_MICRO_FADE_MS
from podcast_mcp.models import Clip, ClipJoinMode
from podcast_mcp.models.clip_timing import MAX_TIMING_STEPS
from podcast_mcp.util.coded_error import CodedValueError

_MIN_HOLE_SEC = 1e-6


@dataclass(frozen=True)
class TimingHole:
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
    """A list without a mapped clip comes back as the same object; holes are keyed by the index of
    the shell on their left."""
    if all(clip.timing is None for clip in clips):
        return clips, {}
    expanded: list[Clip] = []
    hole_after: dict[int, TimingHole] = {}
    for clip in clips:
        if clip.timing is None:
            expanded.append(clip)
            continue
        if len(clip.timing.steps) > MAX_TIMING_STEPS:
            raise CodedValueError(
                f"clip {clip.id} has {len(clip.timing.steps)} timing steps; a render takes at "
                f"most {MAX_TIMING_STEPS}. Split the clip or drop the weakest steps.",
                code="timing_map_too_many_steps",
            )
        pieces = clip.virtual_pieces()
        shells = []
        for index, (src_a, src_b, tl_a) in enumerate(pieces):
            piece_ms = max(0, math.floor((src_b - src_a) * 1000))
            fade_in = min(clip.fade_in_ms if index == 0 else micro_fade_ms, piece_ms)
            fade_out = min(
                clip.fade_out_ms if index + 1 == len(pieces) else micro_fade_ms,
                piece_ms - fade_in,
            )
            shells.append(
                clip.model_copy(
                    update={
                        "timing": None,
                        "source_start": src_a,
                        "source_end": src_b,
                        "timeline_start": tl_a,
                        "fade_in_ms": fade_in,
                        "fade_out_ms": fade_out,
                        "join_in_mode": clip.join_in_mode if index == 0 else ClipJoinMode.FADE,
                    }
                )
            )
        for left, right in pairwise(shells):
            if right.timeline_start - left.timeline_end > _MIN_HOLE_SEC:
                hole_after[id(left)] = TimingHole(clip, left, right)
        expanded.extend(shells)
    # Shells sit at the parent's list position; neighbours of the join rules are by time.
    expanded.sort(key=lambda c: c.timeline_start)
    holes = {index: hole_after[id(c)] for index, c in enumerate(expanded) if id(c) in hole_after}
    return expanded, holes
