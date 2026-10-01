"""Thread-safe keyed fan-out for in-process WebSocket subscribers.

Session document/presence and guest progress each keep their own instance so
planes cannot mix. Overflow policy is injected per hub. Subscribers of one key
may live on different event loops; each queue is fed on the loop it
subscribed with.
"""

from __future__ import annotations

import asyncio
import contextlib
import threading
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
        # Each queue remembers the loop it was subscribed on; delivery runs on that loop.
        self._subs: dict[str, dict[asyncio.Queue[dict[str, Any]], asyncio.AbstractEventLoop]] = {}

    def listener_count(self, key: str) -> int:
        with self._lock:
            return len(self._subs.get(key, ()))

    def subscribe(self, key: str, loop: asyncio.AbstractEventLoop) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=self._queue_maxsize)
        with self._lock:
            self._subs.setdefault(key, {})[q] = loop
        return q

    def unsubscribe(self, key: str, q: asyncio.Queue[dict[str, Any]]) -> None:
        emptied = False
        with self._lock:
            subs = self._subs.get(key)
            if not subs:
                return
            subs.pop(q, None)
            if not subs:
                self._subs.pop(key, None)
                emptied = True
        if emptied and self._on_unsubscribed is not None:
            self._on_unsubscribed(key)

    def publish(self, key: str, event: dict[str, Any]) -> None:
        """Schedule delivery of *event* on each subscriber's own loop and return at once.

        Must stay non-blocking: document submit publishes while holding the project lock and
        the document.db write lock. Queue puts and overflow run on the loop, never here.
        Cost is one ``call_soon_threadsafe`` wakeup per distinct subscriber loop per publish
        (one for the usual single-loop key).
        """
        by_loop: dict[asyncio.AbstractEventLoop, list[asyncio.Queue[dict[str, Any]]]] = {}
        with self._lock:
            for queue, loop in self._subs.get(key, {}).items():
                by_loop.setdefault(loop, []).append(queue)
        if not by_loop:
            return
        overflow = self._overflow

        def _put(queues: list[asyncio.Queue[dict[str, Any]]]) -> None:
            for queue in queues:
                try:
                    queue.put_nowait(event)
                except asyncio.QueueFull:
                    overflow(queue, event)

        for loop, queues in by_loop.items():
            with contextlib.suppress(RuntimeError):  # loop already closed
                loop.call_soon_threadsafe(_put, queues)
