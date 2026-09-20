"""Thread-safe keyed fan-out for in-process WebSocket subscribers.

Session document/presence and guest progress each keep their own instance so
planes cannot mix. Overflow policy is injected per hub.
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
from collections import defaultdict
from collections.abc import Callable
from typing import Any

OverflowHandler = Callable[[asyncio.Queue[dict[str, Any]], dict[str, Any]], None]
UnsubscribedHandler = Callable[[str], None]


def drop_oldest_overflow(queue: asyncio.Queue[dict[str, Any]], event: dict[str, Any]) -> None:
    """Drop the oldest queued item, then enqueue *event*."""
    with contextlib.suppress(asyncio.QueueEmpty):
        queue.get_nowait()
    with contextlib.suppress(asyncio.QueueFull):
        queue.put_nowait(event)


class FanoutHub:
    """Subscribe / publish queues keyed by an opaque string (path or token)."""

    def __init__(
        self,
        *,
        queue_maxsize: int = 64,
        overflow: OverflowHandler | None = None,
        on_unsubscribed: UnsubscribedHandler | None = None,
    ) -> None:
        self._queue_maxsize = queue_maxsize
        self._overflow = overflow or drop_oldest_overflow
        self._on_unsubscribed = on_unsubscribed
        self._lock = threading.Lock()
        self._subs: dict[str, set[asyncio.Queue[dict[str, Any]]]] = defaultdict(set)
        self._loops: dict[str, asyncio.AbstractEventLoop] = {}

    def listener_count(self, key: str) -> int:
        with self._lock:
            return len(self._subs.get(key, ()))

    def subscribe(self, key: str, loop: asyncio.AbstractEventLoop) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self._queue_maxsize)
        with self._lock:
            self._subs[key].add(q)
            self._loops[key] = loop
        return q

    def unsubscribe(self, key: str, q: asyncio.Queue[dict[str, Any]]) -> None:
        emptied = False
        with self._lock:
            subs = self._subs.get(key)
            if not subs:
                return
            subs.discard(q)
            if not subs:
                self._subs.pop(key, None)
                self._loops.pop(key, None)
                emptied = True
        if emptied and self._on_unsubscribed is not None:
            self._on_unsubscribed(key)

    def publish(self, key: str, event: dict[str, Any]) -> None:
        with self._lock:
            subs = list(self._subs.get(key, ()))
            loop = self._loops.get(key)
        if not subs or loop is None:
            return
        overflow = self._overflow

        def _put() -> None:
            for queue in subs:
                try:
                    queue.put_nowait(event)
                except asyncio.QueueFull:
                    overflow(queue, event)

        with contextlib.suppress(RuntimeError):
            loop.call_soon_threadsafe(_put)
