from __future__ import annotations

import time
from unittest.mock import patch

import pytest

from podcast_mcp.util.parallel import resolve_worker_count, run_parallel


def test_resolve_worker_count_single_item_is_serial():
    assert resolve_worker_count(None, 1) == 1
    assert resolve_worker_count(0, 1) == 1
    assert resolve_worker_count(4, 1) == 1


def test_resolve_worker_count_zero_items_is_serial():
    assert resolve_worker_count(None, 0) == 1


def test_resolve_worker_count_auto_uses_cpu_count():
    with patch("podcast_mcp.util.parallel.os.cpu_count", return_value=4):
        assert resolve_worker_count(None, 100) == 6
        assert resolve_worker_count(0, 100) == 6


def test_resolve_worker_count_auto_caps_at_eight():
    with patch("podcast_mcp.util.parallel.os.cpu_count", return_value=64):
        assert resolve_worker_count(None, 100) == 8


def test_resolve_worker_count_auto_bounded_by_item_count():
    with patch("podcast_mcp.util.parallel.os.cpu_count", return_value=16):
        assert resolve_worker_count(None, 3) == 3


def test_resolve_worker_count_auto_falls_back_when_cpu_count_none():
    with patch("podcast_mcp.util.parallel.os.cpu_count", return_value=None):
        assert resolve_worker_count(None, 100) == 6


def test_resolve_worker_count_explicit_serial_override():
    assert resolve_worker_count(1, 100) == 1


def test_resolve_worker_count_explicit_cap():
    assert resolve_worker_count(3, 100) == 3
    assert resolve_worker_count(20, 5) == 5


def test_run_parallel_empty_list():
    assert run_parallel([], lambda x: x) == []


def test_run_parallel_preserves_order_regardless_of_completion_time():
    # Item 0 sleeps longest, item 4 returns fastest -- output must still be [0, 1, 2, 3, 4].
    delays = [0.05, 0.04, 0.03, 0.02, 0.01]

    def slow_identity(i: int) -> int:
        time.sleep(delays[i])
        return i

    result = run_parallel(list(range(5)), slow_identity, max_workers=5)
    assert result == [0, 1, 2, 3, 4]


def test_run_parallel_serial_mode_runs_in_process(monkeypatch):
    calls: list[int] = []

    def record(i: int) -> int:
        calls.append(i)
        return i * 2

    result = run_parallel([1, 2, 3], record, max_workers=1)
    assert result == [2, 4, 6]
    assert calls == [1, 2, 3]


def test_run_parallel_propagates_first_exception():
    def boom(i: int) -> int:
        if i == 1:
            raise ValueError(f"bad item {i}")
        return i

    with pytest.raises(ValueError, match="bad item 1"):
        run_parallel([0, 1, 2], boom, max_workers=3)


def test_run_parallel_serial_mode_propagates_exception():
    def boom(i: int) -> int:
        if i == 1:
            raise ValueError("bad")
        return i

    with pytest.raises(ValueError, match="bad"):
        run_parallel([0, 1, 2], boom, max_workers=1)


def test_run_parallel_matches_serial_output_for_pure_function():
    def square(i: int) -> int:
        return i * i

    items = list(range(20))
    serial = run_parallel(items, square, max_workers=1)
    parallel = run_parallel(items, square, max_workers=4)
    assert serial == parallel == [i * i for i in items]
