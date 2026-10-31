"""Run one call's transcribe jobs side by side, each on its own model and engine state."""

from __future__ import annotations

import contextvars
import copy
import queue
import threading
from collections.abc import Callable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from typing import TYPE_CHECKING, TypeVar

from podcast_mcp.engines.models.whisper import WHISPER_SIZE_BYTES
from podcast_mcp.util.hardware import available_ram_bytes, cpu_budget

if TYPE_CHECKING:
    from podcast_mcp.engines.transcribe import TranscriptionEngine

T = TypeVar("T")
J = TypeVar("J")

WORKER_CPU_THREADS = 4
# Measured with the default product model: about 1 GB per extra loaded model plus its working set.
DEFAULT_WORKER_RAM_BYTES = 2_400_000_000
WORKER_OVERHEAD_BYTES = 800_000_000
AVAILABLE_RAM_FRACTION = 0.7

_STATE_LISTS = ("silence_filter_skipped", "forced_alignment_jobs", "asr_loop_drops")


def worker_ram_bytes(model_size: str) -> int:
    size = WHISPER_SIZE_BYTES.get(model_size)
    return DEFAULT_WORKER_RAM_BYTES if size is None else WORKER_OVERHEAD_BYTES + size


def transcribe_worker_count(model_size: str, job_count: int) -> int:
    """Workers that fit the CPU budget and 70% of the RAM free now; 1 when either is short."""
    if job_count < 2:
        return 1
    free = available_ram_bytes()
    by_memory = (
        1 if free is None else int(free * AVAILABLE_RAM_FRACTION) // worker_ram_bytes(model_size)
    )
    return max(1, min(job_count, cpu_budget() // WORKER_CPU_THREADS, by_memory))


def _worker_engine(engine: TranscriptionEngine, workers: int) -> TranscriptionEngine:
    clone = copy.copy(engine)
    clone._model = None
    clone._loop_drop = None
    if clone.cpu_threads is None:
        clone.cpu_threads = WORKER_CPU_THREADS
    elif workers > 1:
        clone.cpu_threads = min(WORKER_CPU_THREADS, max(1, clone.cpu_threads // workers))
    for name in _STATE_LISTS:
        setattr(clone, name, [])
    return clone


def run_jobs_concurrently(
    engine: TranscriptionEngine,
    jobs: Sequence[J],
    workers: int,
    run: Callable[[TranscriptionEngine, J], T],
) -> list[T]:
    """Results in job order; the earliest failing job's exception propagates once all stop."""
    slots: queue.SimpleQueue[TranscriptionEngine] = queue.SimpleQueue()
    for _ in range(workers):
        slots.put(_worker_engine(engine, workers))
    stop = threading.Event()
    state: list[dict[str, list] | None] = [None] * len(jobs)

    def work(index: int, job: J) -> T | None:
        if stop.is_set():
            return None
        worker = slots.get()
        try:
            return run(worker, job)
        except BaseException:
            stop.set()
            raise
        finally:
            state[index] = {name: getattr(worker, name) for name in _STATE_LISTS}
            for name in _STATE_LISTS:
                setattr(worker, name, [])
            slots.put(worker)

    futures: list[Future[T | None]] = []
    pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="transcribe")
    try:
        for index, job in enumerate(jobs):
            futures.append(pool.submit(contextvars.copy_context().run, work, index, job))
        pool.shutdown(wait=True)
    except BaseException:
        # KeyboardInterrupt lands in the wait above: drop the queued jobs, let running ones end.
        stop.set()
        pool.shutdown(wait=True, cancel_futures=True)
        raise
    for name in _STATE_LISTS:
        for entry in state:
            if entry is not None:
                getattr(engine, name).extend(entry[name])
    results: list[T] = []
    for future in futures:
        value = future.result()
        if value is not None:
            results.append(value)
    return results
