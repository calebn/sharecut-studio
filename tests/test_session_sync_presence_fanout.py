"""Presence fanout coalescer publishes at most 10 Hz per project key."""

from __future__ import annotations

import contextlib
import threading
from typing import ClassVar

from podcast_mcp.services.session_sync import presence_fanout
from podcast_mcp.services.session_sync.hub import get_hub


class _FakeTimer:
    instances: ClassVar[list[_FakeTimer]] = []

    def __init__(self, delay: float, fn) -> None:
        self.delay = delay
        self.fn = fn
        self.daemon = False
        self.cancelled = False
        type(self).instances.append(self)

    def start(self) -> None:
        pass

    def cancel(self) -> None:
        self.cancelled = True


def test_presence_fanout_coalesces_trailing_publish() -> None:
    presence_fanout.reset()
    _FakeTimer.instances = []
    presence_fanout.set_timer_factory(_FakeTimer)
    key = "coalesce-key"
    loop = __import__("asyncio").new_event_loop()
    q = get_hub().subscribe(key, loop)
    try:
        n = {"i": 0}

        def build() -> list[dict]:
            n["i"] += 1
            return [{"type": "Presence", "n": n["i"]}]

        for _ in range(25):
            presence_fanout.schedule(key, build, min_interval_s=0.1)
        loop.run_until_complete(__import__("asyncio").sleep(0))
        first = []
        while True:
            try:
                first.append(q.get_nowait())
            except Exception:
                break
        assert len(first) == 1
        assert _FakeTimer.instances
        _FakeTimer.instances[-1].fn()
        loop.run_until_complete(__import__("asyncio").sleep(0))
        second = []
        while True:
            try:
                second.append(q.get_nowait())
            except Exception:
                break
        assert len(second) == 1
    finally:
        get_hub().unsubscribe(key, q)
        loop.close()
        presence_fanout.reset()
        presence_fanout.set_timer_factory(threading.Timer)


def test_presence_fanout_publish_failure_clears_cooldown() -> None:
    presence_fanout.reset()
    _FakeTimer.instances = []
    presence_fanout.set_timer_factory(_FakeTimer)
    key = "fail-key"

    def boom() -> list[dict]:
        raise RuntimeError("publish build failed")

    try:
        with contextlib.suppress(RuntimeError):
            presence_fanout.schedule(key, boom, min_interval_s=0.1)
        n = {"i": 0}

        def build() -> list[dict]:
            n["i"] += 1
            return [{"type": "Presence", "n": n["i"]}]

        loop = __import__("asyncio").new_event_loop()
        q = get_hub().subscribe(key, loop)
        try:
            presence_fanout.schedule(key, build, min_interval_s=0.1)
            loop.run_until_complete(__import__("asyncio").sleep(0))
            got = []
            while True:
                try:
                    got.append(q.get_nowait())
                except Exception:
                    break
            assert got == [{"type": "Presence", "n": 1}]
        finally:
            get_hub().unsubscribe(key, q)
            loop.close()
    finally:
        presence_fanout.reset()
        presence_fanout.set_timer_factory(threading.Timer)


def test_presence_fanout_clears_on_last_unsubscribe() -> None:
    presence_fanout.reset()
    _FakeTimer.instances = []
    presence_fanout.set_timer_factory(_FakeTimer)
    key = "empty-key"
    loop = __import__("asyncio").new_event_loop()
    q = get_hub().subscribe(key, loop)
    try:
        presence_fanout.schedule(key, lambda: [{"type": "Presence"}], min_interval_s=0.1)
        assert key in presence_fanout._in_cooldown
    finally:
        get_hub().unsubscribe(key, q)
        loop.close()
    assert key not in presence_fanout._in_cooldown
    presence_fanout.reset()
    presence_fanout.set_timer_factory(threading.Timer)


def test_presence_fanout_trailing_publish_failure_clears_cooldown() -> None:
    presence_fanout.reset()
    _FakeTimer.instances = []
    presence_fanout.set_timer_factory(_FakeTimer)
    key = "trail-fail"
    loop = __import__("asyncio").new_event_loop()
    q = get_hub().subscribe(key, loop)

    def ok() -> list[dict]:
        return [{"type": "Presence", "n": 1}]

    def boom() -> list[dict]:
        raise RuntimeError("trailing publish failed")

    try:
        presence_fanout.schedule(key, ok, min_interval_s=0.1)
        presence_fanout.schedule(key, boom, min_interval_s=0.1)
        raised = False
        try:
            _FakeTimer.instances[-1].fn()
        except RuntimeError:
            raised = True
        assert raised
        assert key not in presence_fanout._in_cooldown
    finally:
        get_hub().unsubscribe(key, q)
        loop.close()
        presence_fanout.reset()
        presence_fanout.set_timer_factory(threading.Timer)


def test_presence_fanout_uses_leading_builder_on_leading_edge_only() -> None:
    presence_fanout.reset()
    _FakeTimer.instances = []
    presence_fanout.set_timer_factory(_FakeTimer)
    key = "leading-key"
    loop = __import__("asyncio").new_event_loop()
    q = get_hub().subscribe(key, loop)

    def build() -> list[dict]:
        return [{"type": "Presence", "n": "build"}]

    def lead() -> list[dict]:
        return [{"type": "Presence", "n": "lead"}]

    try:
        presence_fanout.schedule(key, build, min_interval_s=0.1, leading=lead)
        loop.run_until_complete(__import__("asyncio").sleep(0))
        first = []
        while True:
            try:
                first.append(q.get_nowait())
            except Exception:
                break
        assert [e["n"] for e in first] == ["lead"]
        # Second call in the same cooldown window: only build() is stored for the trailing
        # edge (leading is only consulted on the immediate publish).
        presence_fanout.schedule(key, build, min_interval_s=0.1, leading=lead)
        assert _FakeTimer.instances
        _FakeTimer.instances[-1].fn()
        loop.run_until_complete(__import__("asyncio").sleep(0))
        second = []
        while True:
            try:
                second.append(q.get_nowait())
            except Exception:
                break
        assert [e["n"] for e in second] == ["build"]
    finally:
        get_hub().unsubscribe(key, q)
        loop.close()
        presence_fanout.reset()
        presence_fanout.set_timer_factory(threading.Timer)


def test_presence_fanout_and_tracker_under_thread_contention() -> None:
    import asyncio

    from podcast_mcp.services.session_sync.presence_delta import PresenceRosterTracker

    presence_fanout.reset()
    presence_fanout.set_timer_factory(threading.Timer)
    tracker = PresenceRosterTracker()
    loop = asyncio.new_event_loop()
    keys = [f"stress-{i}" for i in range(3)]
    queues = {key: get_hub().subscribe(key, loop) for key in keys}
    errors: list[BaseException] = []

    def worker(n: int) -> None:
        try:
            for i in range(200):
                key = keys[i % len(keys)]
                rows = [
                    {"client_id": f"c{j}", "last_seen_ns": i, "meta": {"n": n}}
                    for j in range(3 + (i % 2))
                ]
                presence_fanout.schedule(
                    key,
                    lambda key=key, rows=rows: tracker.events(key, rows),
                    min_interval_s=0.001,
                )
        except Exception as exc:  # surfaced below
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
    try:
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        assert not any(t.is_alive() for t in threads), "deadlock: worker still running"
        assert errors == []
    finally:
        presence_fanout.reset()
        for key, q in queues.items():
            get_hub().unsubscribe(key, q)
        loop.close()
        presence_fanout.set_timer_factory(threading.Timer)
