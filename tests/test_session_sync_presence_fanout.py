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

        def build() -> dict:
            n["i"] += 1
            return {"type": "Presence", "n": n["i"]}

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

    def boom() -> dict:
        raise RuntimeError("publish build failed")

    try:
        with contextlib.suppress(RuntimeError):
            presence_fanout.schedule(key, boom, min_interval_s=0.1)
        n = {"i": 0}

        def build() -> dict:
            n["i"] += 1
            return {"type": "Presence", "n": n["i"]}

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
        presence_fanout.schedule(key, lambda: {"type": "Presence"}, min_interval_s=0.1)
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

    def ok() -> dict:
        return {"type": "Presence", "n": 1}

    def boom() -> dict:
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
