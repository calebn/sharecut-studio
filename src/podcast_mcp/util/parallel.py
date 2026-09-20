from __future__ import annotations

import os
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import TypeVar

T = TypeVar("T")
R = TypeVar("R")


def resolve_worker_count(configured: int | None, item_count: int) -> int:
    """Resolve how many worker threads to use for a batch of item_count tasks.

    0 or None = auto (cpu_count-based, capped at 8); 1 = force serial;
    >1 = explicit cap, still bounded by item_count (no point spawning more
    workers than there is work).
    """
    if item_count <= 1:
        return 1
    if configured is None or configured == 0:
        auto = min(8, (os.cpu_count() or 4) + 2)
        return max(1, min(auto, item_count))
    return max(1, min(int(configured), item_count))


def run_parallel(
    items: list[T],
    fn: Callable[[T], R],
    *,
    max_workers: int | None = None,
) -> list[R]:
    """Run fn(item) for each item, returning results in the SAME order as items
    regardless of completion order.

    max_workers<=1 (after resolve_worker_count) runs strictly serially in-process
    (no thread pool at all) - used for single-item batches and for tests/debugging
    that need deterministic single-threaded reproduction.

    The first exception raised by any task propagates to the caller (via
    Future.result()), matching the pre-existing behavior of a single failing
    step aborting the whole pipeline run.
    """
    if not items:
        return []
    workers = resolve_worker_count(max_workers, len(items))
    if workers <= 1:
        return [fn(item) for item in items]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(fn, item) for item in items]
        return [f.result() for f in futures]
