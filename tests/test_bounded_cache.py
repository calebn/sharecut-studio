from __future__ import annotations

import threading

import pytest

from podcast_mcp.util.bounded_cache import BoundedCache


def test_miss_returns_none_and_hit_returns_the_value() -> None:
    cache: BoundedCache[str, int] = BoundedCache(2)
    assert cache.get("a") is None
    cache.put("a", 1)
    assert cache.get("a") == 1
    assert "a" in cache
    assert len(cache) == 1


def test_put_past_the_bound_evicts_the_least_recently_used() -> None:
    cache: BoundedCache[str, int] = BoundedCache(2)
    cache.put("a", 1)
    cache.put("b", 2)
    assert cache.get("a") == 1
    cache.put("c", 3)
    assert "b" not in cache
    assert (cache.get("a"), cache.get("c")) == (1, 3)
    assert len(cache) == 2


def test_put_on_an_existing_key_replaces_and_refreshes_it() -> None:
    cache: BoundedCache[str, int] = BoundedCache(2)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.put("a", 10)
    cache.put("c", 3)
    assert "b" not in cache
    assert cache.get("a") == 10


def test_pop_removes_and_returns_the_entry() -> None:
    cache: BoundedCache[str, int] = BoundedCache(2)
    cache.put("a", 1)
    assert cache.pop("a") == 1
    assert cache.pop("a") is None
    assert len(cache) == 0


def test_clear_empties_the_cache() -> None:
    cache: BoundedCache[str, int] = BoundedCache(3)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.clear()
    assert len(cache) == 0
    assert cache.get("a") is None


def test_maxsize_must_be_positive() -> None:
    with pytest.raises(ValueError, match="maxsize"):
        BoundedCache(0)


def test_concurrent_puts_never_exceed_the_bound() -> None:
    cache: BoundedCache[int, int] = BoundedCache(8)

    def fill(start: int) -> None:
        for key in range(start, start + 200):
            cache.put(key, key)
            assert len(cache) <= 8

    threads = [threading.Thread(target=fill, args=(n * 1000,)) for n in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(cache) == 8


def test_lock_is_reentrant_so_a_caller_can_hold_it_across_get_and_put() -> None:
    cache: BoundedCache[str, int] = BoundedCache(1)
    with cache.lock:
        assert cache.get("a") is None
        cache.put("a", 1)
    assert cache.get("a") == 1


def test_iteration_lists_keys_least_recently_used_first() -> None:
    cache: BoundedCache[str, int] = BoundedCache(3)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.get("a")
    assert list(cache) == ["b", "a"]
