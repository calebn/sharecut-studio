from __future__ import annotations

from podcast_mcp.util.intervals import HalfOpenIntervalIndex, intersect_intervals


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


def test_half_open_index_start_rank() -> None:
    index = HalfOpenIntervalIndex.build([(5.0, 6.0), (1.0, 2.0), (3.0, 3.0)])
    assert index.starts == (1.0, 5.0)
    assert index.ordinals == (1, 0)
    assert index.start_rank(0.5) == 0
    assert index.start_rank(1.0) == 1
    assert index.start_rank(4.0) == 1
    assert index.start_rank(5.0) == 2
    assert index.start_rank(9.0) == 2


def test_intersect_intervals() -> None:
    assert intersect_intervals([(0, 2), (3, 6)], [(1, 4), (5, 9)]) == [(1, 2), (3, 4), (5, 6)]
    assert intersect_intervals([(0, 1)], [(2, 3)]) == []
    assert intersect_intervals([(0, 2), (1, 3)], [(0, 10)]) == [(0, 3)]


def test_subtract_intervals_sweep_matches_removing_one_at_a_time():
    import random

    from podcast_mcp.util.intervals import _subtract_sequential, subtract_intervals

    rng = random.Random(7)

    def span() -> tuple[float, float]:
        start = rng.choice([rng.randint(0, 20), rng.random() * 20])
        return start, start + rng.choice([0, rng.randint(0, 6), rng.random() * 5])

    for _ in range(3000):
        segments = [span() for _ in range(rng.choice([0, 1, 2, 5, 12]))]
        if rng.random() < 0.5:
            segments = [(lo, hi) for lo, hi in segments if hi > lo]
        removes = [span() for _ in range(rng.choice([0, 1, 3, 9, 20]))]
        assert subtract_intervals(list(segments), list(removes)) == _subtract_sequential(
            list(segments), list(removes), 0.0
        )
