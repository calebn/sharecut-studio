"""In-process fanout for WebSocket subscribers (per project path)."""

from __future__ import annotations

import asyncio
import contextlib
import threading
from collections.abc import Callable
from typing import Any

from podcast_mcp.services.fanout_hub import FanoutHub


def _clear_presence_key(project_key: str) -> None:
    from podcast_mcp.services.session_sync.presence_fanout import clear_key

    clear_key(project_key)


class SessionHub(FanoutHub):
    """Thread-safe registry of async queues for Applied events."""

    def __init__(self) -> None:
        super().__init__(
            queue_maxsize=256,
            overflow=_session_overflow,
            on_unsubscribed=self._key_idle,
        )
        self._seq_lock = threading.Lock()
        self._applied_seq: dict[str, int] = {}

    def publish(self, key: str, event: dict[str, Any]) -> None:
        """Remember ``event``'s seq when it is an ``Applied``, then fan it out (#695).

        Recorded before the base publish returns early for a key with no subscribers,
        so an in-process write is known even while no socket listens on that plane.
        """
        seq = _applied_server_seq(event)
        if seq is not None:
            with self._seq_lock:
                self._applied_seq[key] = seq
        super().publish(key, event)

    def last_applied_seq(self, key: str) -> int | None:
        """``server_seq`` of the last ``Applied`` this process published for ``key`` (#695).

        The cross-process watcher (``services/cross_process_sync.py``) skips a journal
        head equal to it: that row was written, and already fanned out, in this process.
        """
        with self._seq_lock:
            return self._applied_seq.get(key)

    def _key_idle(self, key: str) -> None:
        with self._seq_lock:
            self._applied_seq.pop(key, None)
        _clear_presence_key(key)


def _applied_server_seq(event: dict[str, Any] | None) -> int | None:
    if not isinstance(event, dict) or event.get("type") != "Applied":
        return None
    seq = event.get("server_seq")
    return seq if isinstance(seq, int) and not isinstance(seq, bool) else None


def _record_signal(event: dict[str, Any] | None) -> bool:
    return isinstance(event, dict) and event.get("type") == "Signal"


def _record_applied(event: dict[str, Any] | None) -> bool:
    return (
        isinstance(event, dict)
        and event.get("plane") == "record"
        and event.get("type") in {"Applied", "Snapshot"}
    )


def _session_overflow(q: asyncio.Queue[dict[str, Any]], event: dict[str, Any]) -> None:
    if _document_applied(event):
        _drain_queue(q)
        with contextlib.suppress(asyncio.QueueFull):  # pragma: no cover
            q.put_nowait(document_overflow_resync(event))
        return
    to_put = _enqueue_prefer_drop_signal(q, event)
    if to_put is None:
        return
    with contextlib.suppress(asyncio.QueueFull):  # pragma: no cover
        q.put_nowait(to_put)


def _enqueue_prefer_drop_signal(
    q: asyncio.Queue[dict[str, Any]],
    event: dict[str, Any],
) -> dict[str, Any] | None:
    buffered: list[dict[str, Any]] = []
    while True:
        try:
            buffered.append(q.get_nowait())
        except asyncio.QueueEmpty:
            break
    drop_at = next((i for i, row in enumerate(buffered) if _record_signal(row)), None)
    if drop_at is None and _record_signal(event):
        for row in buffered:
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(row)
        return None
    if drop_at is not None:
        del buffered[drop_at]
    elif buffered:
        drop_at = next((i for i, row in enumerate(buffered) if not _record_applied(row)), 0)
        del buffered[drop_at]
    for row in buffered:
        with contextlib.suppress(asyncio.QueueFull):
            q.put_nowait(row)
    return event


def _document_applied(event: dict[str, Any] | None) -> bool:
    if not isinstance(event, dict) or event.get("plane") != "document":
        return False
    return event.get("type") in {"Applied", "Snapshot"}


def _drain_queue(q: asyncio.Queue[dict[str, Any]]) -> None:
    while True:
        try:
            q.get_nowait()
        except asyncio.QueueEmpty:
            return


def document_overflow_resync(event: dict[str, Any]) -> dict[str, Any]:
    """Tag a document Applied so the peer discards backlog and refetches shell."""
    snap = event.get("snapshot")
    base: dict[str, Any] = dict(snap) if isinstance(snap, dict) else {}
    out = dict(event)
    out["snapshot"] = {**base, "resync": True}
    return out


_HUB = SessionHub()


def get_hub() -> SessionHub:
    return _HUB


FanoutHook = Callable[[str, dict[str, Any]], None]
