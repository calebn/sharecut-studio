from __future__ import annotations

import dataclasses
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import patch

import pytest

from podcast_mcp.util.hardware import cpu_only_profile, use_hardware_profile
from podcast_mcp.util.parallel import resolve_worker_count, run_parallel


def test_resolve_worker_count_single_item_is_serial():
    assert resolve_worker_count(None, 1) == 1
    assert resolve_worker_count(0, 1) == 1
    assert resolve_worker_count(4, 1) == 1


def test_resolve_worker_count_zero_items_is_serial():
    assert resolve_worker_count(None, 0) == 1


def _budget(cores: int):
    return use_hardware_profile(dataclasses.replace(cpu_only_profile(cores), effective_cores=cores))


def test_resolve_worker_count_auto_uses_the_cpu_budget():
    with _budget(4):
        assert resolve_worker_count(None, 100) == 6
        assert resolve_worker_count(0, 100) == 6


def test_resolve_worker_count_auto_follows_a_container_limit_below_the_logical_cores():
    profile = dataclasses.replace(cpu_only_profile(16), effective_cores=2)
    with use_hardware_profile(profile):
        assert resolve_worker_count(None, 100) == 4


def test_resolve_worker_count_auto_caps_at_eight():
    with _budget(64):
        assert resolve_worker_count(None, 100) == 8


def test_resolve_worker_count_auto_bounded_by_item_count():
    with _budget(16):
        assert resolve_worker_count(None, 3) == 3


def test_resolve_worker_count_explicit_serial_override():
    assert resolve_worker_count(1, 100) == 1


def test_resolve_worker_count_explicit_cap():
    assert resolve_worker_count(3, 100) == 3
    assert resolve_worker_count(20, 5) == 5


def test_run_parallel_empty_list():
    assert run_parallel([], lambda x: x) == []


def test_run_parallel_preserves_order_regardless_of_completion_time():
    completion_order: list[int] = []
    release = [Event() for _ in range(5)]

    class CompletionTrackingExecutor(ThreadPoolExecutor):
        def submit(self, fn, /, *args, **kwargs):
            future = super().submit(fn, *args, **kwargs)
            position = args[-1]

            def record_completion(_future):
                # Done callbacks run only after the Future has completed.
                completion_order.append(position)
                if position:
                    release[position - 1].set()

            future.add_done_callback(record_completion)
            return future

    def gated_identity(i: int) -> int:
        assert release[i].wait(timeout=2), f"item {i} was never released"
        return i

    release[-1].set()
    with patch("podcast_mcp.util.parallel.ThreadPoolExecutor", CompletionTrackingExecutor):
        result = run_parallel(list(range(5)), gated_identity, max_workers=5)

    assert completion_order == [4, 3, 2, 1, 0]
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


def test_run_parallel_tasks_keep_the_callers_niceness_and_nothing_else():
    import contextvars

    from podcast_mcp.util.process import current_niceness, low_priority

    marker: contextvars.ContextVar[str] = contextvars.ContextVar("marker", default="unset")
    marker.set("caller")

    def probe(_item: int) -> tuple[int, str]:
        return current_niceness(), marker.get()

    with low_priority(7):
        assert run_parallel([1, 2, 3], probe, max_workers=3) == [(7, "unset")] * 3
    assert run_parallel([1, 2], probe, max_workers=2) == [(0, "unset")] * 2


def test_run_parallel_workers_share_the_callers_batch_scope():
    from podcast_mcp.util.batch_scope import batch_scope, frozen, frozen_state, scoped

    made: list[int] = []

    def read(i: int) -> tuple[int, int]:
        shared = scoped(("key",), lambda: made.append(i) or i)
        return shared, frozen(("frozen",), lambda: i)

    with batch_scope(), frozen_state():
        first = read(0)
        results = run_parallel([1, 2, 3, 4], read, max_workers=4)

    assert results == [first] * 4
    assert made == [0]
    # Outside a scope the workers share nothing.
    assert run_parallel([1, 2], read, max_workers=2) == [(1, 1), (2, 2)]
