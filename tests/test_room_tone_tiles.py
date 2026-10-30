from __future__ import annotations

from itertools import pairwise

import pytest

from podcast_mcp.engines.room_tone_tiles import (
    CROSSFADE_REACH_SEC,
    MIN_TILE_SEC,
    Tile,
    tile_span,
)


def test_a_gap_the_span_covers_is_one_tile_from_its_start() -> None:
    assert tile_span(10.0, 13.0, 2.0, seed_sec=99.0) == (Tile(10.0, 2.0),)
    assert tile_span(10.0, 13.0, 3.0, seed_sec=5.0) == (Tile(10.0, 3.0),)


def test_nothing_to_fill_gives_no_tiles() -> None:
    assert tile_span(10.0, 13.0, 0.0, seed_sec=0.0) == ()
    assert tile_span(13.0, 13.0, 1.0, seed_sec=0.0) == ()


def test_a_long_gap_is_equal_tiles_that_sum_to_the_gap() -> None:
    tiles = tile_span(10.0, 13.0, 21.0, seed_sec=4.0)

    assert len(tiles) > 1
    assert sum(t.length for t in tiles) == pytest.approx(21.0)
    assert len({round(t.length, 9) for t in tiles}) == 1


def test_every_read_including_the_blend_borrow_stays_inside_the_span() -> None:
    for seed in (0.0, 1.5, 37.2, 1234.567):
        for tile in tile_span(10.0, 13.0, 21.0, seed_sec=seed):
            assert tile.source_start - tile.reach_in >= 10.0 - 1e-9
            assert tile.source_start + tile.length + tile.reach_out <= 13.0 + 1e-9


def test_only_inner_joins_borrow() -> None:
    tiles = tile_span(10.0, 13.0, 21.0, seed_sec=4.0)

    assert tiles[0].reach_in == 0.0
    assert tiles[-1].reach_out == 0.0
    assert all(t.reach_in == CROSSFADE_REACH_SEC for t in tiles[1:])
    assert all(t.reach_out == CROSSFADE_REACH_SEC for t in tiles[:-1])


def test_adjacent_tiles_start_at_different_offsets() -> None:
    tiles = tile_span(10.0, 13.0, 21.0, seed_sec=4.0)

    assert all(a.source_start != b.source_start for a, b in pairwise(tiles))


def test_a_join_is_a_rewind_or_a_gap_wide_enough_to_borrow_from() -> None:
    for seed in range(60):
        tiles = tile_span(0.0, 3.0, 24.0, seed_sec=float(seed))
        for left, right in pairwise(tiles):
            ahead = right.source_start - (left.source_start + left.length)
            assert ahead <= 1e-9 or ahead >= 2 * CROSSFADE_REACH_SEC - 1e-9


def test_the_same_position_gives_the_same_tiles() -> None:
    assert tile_span(2.0, 5.0, 30.0, seed_sec=12.34) == tile_span(2.0, 5.0, 30.0, seed_sec=12.34)
    assert tile_span(2.0, 5.0, 30.0, seed_sec=12.34) != tile_span(2.0, 5.0, 30.0, seed_sec=99.0)


def test_a_span_too_short_to_inset_is_butt_spliced_from_its_start() -> None:
    tiles = tile_span(4.0, 4.25, 1.0, seed_sec=0.0)

    assert [t.source_start for t in tiles] == [4.0, 4.0, 4.0, 4.0]
    assert sum(t.length for t in tiles) == pytest.approx(1.0)
    assert all(t.reach_in == 0.0 and t.reach_out == 0.0 for t in tiles)


def test_blended_tiles_are_long_enough_to_blend() -> None:
    for gap in (3.5, 7.0, 20.0, 120.0):
        assert all(t.length >= MIN_TILE_SEC for t in tile_span(0.0, 1.5, gap, seed_sec=gap))
