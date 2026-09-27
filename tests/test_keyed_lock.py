"""KeyedLocks: one in-process lock per key."""

from __future__ import annotations

import threading

from podcast_mcp.util.keyed_lock import KeyedLocks


def test_get_returns_one_lock_per_key() -> None:
    locks: KeyedLocks[str, threading.Lock] = KeyedLocks(threading.Lock)
    a = locks.get("a")
    assert a is locks.get("a")
    assert a is not locks.get("b")
    assert "a" in locks
    assert "missing" not in locks


def test_get_uses_the_factory() -> None:
    locks: KeyedLocks[str, threading.RLock] = KeyedLocks(threading.RLock)
    lock = locks.get("k")
    with lock:
        with lock:
            pass


def test_discard_idle_drops_unheld_and_keeps_held() -> None:
    locks: KeyedLocks[str, threading.Lock] = KeyedLocks(threading.Lock)
    idle = locks.get("idle")
    locks.discard_idle("idle")
    assert "idle" not in locks

    held = locks.get("busy")
    held.acquire()
    locks.discard_idle("busy")
    assert "busy" in locks
    held.release()
    locks.discard_idle("busy")
    assert "busy" not in locks

    locks.discard_idle("missing")

    fresh = locks.get("idle")
    assert fresh is not idle


def test_concurrent_get_returns_same_lock() -> None:
    locks: KeyedLocks[str, threading.Lock] = KeyedLocks(threading.Lock)
    barrier = threading.Barrier(8)
    results: list[threading.Lock] = []
    results_guard = threading.Lock()

    def worker() -> None:
        barrier.wait()
        lock = locks.get("k")
        with results_guard:
            results.append(lock)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len({id(item) for item in results}) == 1
