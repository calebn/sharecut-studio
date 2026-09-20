from __future__ import annotations

from podcast_mcp.edits.clips_ops import (
    remove_timeline_range_from_clips,
    split_clip_at,
)
from podcast_mcp.models import Clip


def _clip(tl_start: float, src_start: float, dur: float, tid: str = "host") -> Clip:
    return Clip(
        id=f"c_{tl_start}",
        track_id=tid,
        source_start=src_start,
        source_end=src_start + dur,
        timeline_start=tl_start,
    )


def test_split_clip_at() -> None:
    c = _clip(0.0, 0.0, 10.0)
    before, after = split_clip_at(c, 4.0)
    assert before.source_end == 4.0
    assert after.source_start == 4.0
    assert after.timeline_start == 4.0


def test_remove_timeline_range() -> None:
    clips = [_clip(0.0, 0.0, 5.0), _clip(5.0, 5.0, 5.0)]
    out = remove_timeline_range_from_clips(clips, 2.0, 7.0)
    assert len(out) == 2
    assert out[0].source_end == 2.0
    assert out[1].timeline_start == 2.0
    assert out[1].source_start == 7.0
