"""In-process fanout for WebSocket subscribers (per project path)."""

from __future__ import annotations

import asyncio
import contextlib
import threading
from collections import deque
from collections.abc import Callable, Iterable
from typing import Any

from podcast_mcp.services.fanout_hub import FanoutHub


def _clear_presence_key(project_key: str) -> None:
    from podcast_mcp.services.session_sync.presence_delta import get_roster_tracker
    from podcast_mcp.services.session_sync.presence_fanout import clear_key

    clear_key(project_key)
    get_roster_tracker().clear_key(project_key)


_APPLIED_SEQ_MEMORY = 1024
"""``Applied`` seqs ``SessionHub`` remembers per key for the cross-process watcher (#695)."""


class SessionHub(FanoutHub):
    """Thread-safe registry of async queues for Applied events."""

    def __init__(self) -> None:
        super().__init__(
            queue_maxsize=256,
            overflow=_session_overflow,
            on_unsubscribed=self._key_idle,
        )
        self._seq_lock = threading.Lock()
        self._applied_seqs: dict[str, deque[int]] = {}

    def publish(self, key: str, event: dict[str, Any]) -> None:
        """Remember ``event``'s seq when it is an ``Applied``, then fan it out (#695).

        Recorded before the base publish returns early for a key with no subscribers,
        so an in-process write is known even while no socket listens on that plane.
        """
        seq = _applied_server_seq(event)
        if seq is not None:
            self.mark_published(key, (seq,))
        super().publish(key, event)

    def mark_published(self, key: str, seqs: Iterable[int]) -> None:
        """Record journal ``seqs`` as fanned out for ``key``: ``publish`` does this for an
        ``Applied``, and a collapsed cross-process ``Applied`` for every row it covers (#695).

        Idempotent: a seq already remembered is not recorded again, so a collapsed publish
        (which marks its rows, then publishes at the head) spends one slot per distinct seq.
        """
        with self._seq_lock:
            remembered = self._applied_seqs.get(key)
            if remembered is None:
                remembered = deque(maxlen=_APPLIED_SEQ_MEMORY)
                self._applied_seqs[key] = remembered
            known = set(remembered)
            for seq in seqs:
                if seq not in known:
                    known.add(seq)
                    remembered.append(seq)

    def unpublished_seqs(self, key: str, after: int | None, head: int) -> list[int]:
        """Journal seqs in ``(after, head]`` this process has not published for ``key`` (#695).

        ``after=None`` checks ``head`` alone. Only the newest ``_APPLIED_SEQ_MEMORY`` seqs up
        to ``head`` are checked. The cross-process watcher publishes when this is non-empty,
        which means another process wrote a row since its last tick.
        """
        if head <= 0:
            return []
        start = head if after is None else max(after + 1, head - _APPLIED_SEQ_MEMORY + 1)
        with self._seq_lock:
            published = set(self._applied_seqs.get(key, ()))
        return [seq for seq in range(start, head + 1) if seq not in published]

    def _key_idle(self, key: str) -> None:
        with self._seq_lock:
            self._applied_seqs.pop(key, None)
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
