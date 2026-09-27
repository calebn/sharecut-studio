from __future__ import annotations

from podcast_mcp.util.intervals import HalfOpenIntervalIndex


def test_half_open_index_preserves_input_ordinals_and_long_overlaps() -> None:
    index = HalfOpenIntervalIndex.build(
        [(8.0, 8.4), (1.0, 9.0), (3.0, 3.5), (3.0, 3.0), (8.0, 8.2)]
    )
    assert index.overlapping_ordinals(3.5, 8.0) == (1,)
    assert index.overlapping_ordinals(8.0, 8.3) == (1, 0, 4)
    assert index.overlapping_ordinals(9.0, 10.0) == ()
    assert index.overlapping_ordinals(3.0, 3.0) == ()
    assert index.overlaps(8.4, 9.0)
    assert not index.overlaps(9.0, 9.1)
