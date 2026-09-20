"""Token-scoped guest progress fan-out (review share WS plane).

Never publishes host filesystem paths. Host jobs must not use this hub.
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import threading
import time
from typing import Any

from podcast_mcp.services.fanout_hub import FanoutHub
from podcast_mcp.util.progress import (
    PROGRESS_LAZY_CHIP_SEC,
    ElapsedProgressMixin,
    ProgressEvent,
    ProgressReporter,
    short_fail_headline,
)

GUEST_PROGRESS_MAX_HZ = 4
GUEST_PROGRESS_COALESCE_SEC = 1.0 / GUEST_PROGRESS_MAX_HZ
GUEST_PROGRESS_MESSAGE_MAX = 200
GUEST_PROGRESS_LAZY_SEC = PROGRESS_LAZY_CHIP_SEC
_TERMINAL = frozenset({"end", "fail", "cancel"})
_LIVE = frozenset({"start", "update", "message", "heartbeat"})
_TEXT_FIELDS = frozenset({"task_id", "label", "message", "phase"})
_PATHISH = re.compile(
    r"(?:"
    r"file:\S+"
    r"|\\\\[^\s\\]+\\\S+"
    r"|~/[^\s]+"
    r"|[A-Za-z]:\\[^\s]+"
    r"|/(?:Users|home|tmp|var|opt|private|Volumes|mnt|root)[^\s]*"
    r"|/(?:[A-Za-z0-9._-]+/){1,}[A-Za-z0-9._-]+"
    r")"
)


def scrub_guest_progress_text(text: str | None) -> str | None:
    """Redact path-like substrings; cap length. Tool ids like ``guest_get_project`` stay."""
    if text is None:
        return None
    stripped = text.strip()
    if not stripped:
        return None
    redacted = _PATHISH.sub("[path]", stripped)
    if redacted == "[path]":
        return None
    if len(redacted) > GUEST_PROGRESS_MESSAGE_MAX:
        return redacted[: GUEST_PROGRESS_MESSAGE_MAX - 1] + "…"
    return redacted


def guest_progress_payload(event: ProgressEvent) -> dict[str, Any]:
    """Whitelist guest-safe progress fields (no host paths)."""
    kind = event.kind
    if kind == "end":
        status = "ok"
    elif kind == "fail":
        status = "error"
    elif kind == "cancel":
        status = "cancelled"
    else:
        status = "running"
    raw = event.to_dict()
    payload: dict[str, Any] = {
        "type": "progress",
        "plane": "progress",
        "status": status,
    }
    for key, value in raw.items():
        if key in _TEXT_FIELDS:
            scrubbed = scrub_guest_progress_text(value if isinstance(value, str) else None)
            if key == "task_id":
                payload[key] = scrubbed or "task"
            else:
                payload[key] = scrubbed
        else:
            payload[key] = value
    return payload


def _is_terminal_event(event: dict[str, Any]) -> bool:
    return event.get("kind") in _TERMINAL or event.get("status") in {
        "ok",
        "error",
        "cancelled",
    }


def _progress_overflow(queue: asyncio.Queue[dict[str, Any]], event: dict[str, Any]) -> None:
    """Drop non-terminal / coalesce last-value per task_id; keep terminals."""
    buffered: list[dict[str, Any]] = []
    while True:
        try:
            buffered.append(queue.get_nowait())
        except asyncio.QueueEmpty:
            break
    incoming_terminal = _is_terminal_event(event)
    task_id = event.get("task_id")
    if not incoming_terminal:
        replaced = False
        for i, row in enumerate(buffered):
            if row.get("task_id") == task_id and not _is_terminal_event(row):
                buffered[i] = event
                replaced = True
                break
        if not replaced:
            drop_at = next(
                (i for i, row in enumerate(buffered) if not _is_terminal_event(row)),
                None,
            )
            if drop_at is None:
                for row in buffered:
                    with contextlib.suppress(asyncio.QueueFull):
                        queue.put_nowait(row)
                return
            del buffered[drop_at]
            buffered.append(event)
    else:
        buffered = [
            row
            for row in buffered
            if not (row.get("task_id") == task_id and not _is_terminal_event(row))
        ]
        if len(buffered) >= queue.maxsize:
            drop_at = next(
                (i for i, row in enumerate(buffered) if not _is_terminal_event(row)),
                0,
            )
            del buffered[drop_at]
        buffered.append(event)
    for row in buffered:
        with contextlib.suppress(asyncio.QueueFull):
            queue.put_nowait(row)


class GuestProgressHub(FanoutHub):
    """Token-keyed fan-out; last running payload is replayed to new subscribers."""

    def __init__(self) -> None:
        super().__init__(queue_maxsize=64, overflow=_progress_overflow)
        self._last: dict[str, dict[str, Any]] = {}

    def subscribe(
        self, token: str, loop: asyncio.AbstractEventLoop
    ) -> asyncio.Queue[dict[str, Any]]:
        q = super().subscribe(token, loop)
        with self._lock:
            last = self._last.get(token)
        if last is not None:
            with contextlib.suppress(asyncio.QueueFull):
                q.put_nowait(last)
        return q

    def publish(self, token: str, event: dict[str, Any]) -> None:
        with self._lock:
            if _is_terminal_event(event):
                self._last.pop(token, None)
            else:
                self._last[token] = event
        super().publish(token, event)


_HUB = GuestProgressHub()


def guest_progress_hub() -> GuestProgressHub:
    return _HUB


def reset_guest_progress_hub() -> None:
    """Tests only."""
    global _HUB
    _HUB = GuestProgressHub()


class GuestWsProgressReporter(ElapsedProgressMixin):
    """Live guest-WS sink: lazy chip, ≤4/s coalesce, terminal flush, heartbeats."""

    def __init__(
        self,
        hub: GuestProgressHub,
        token: str,
        *,
        heartbeat_sec: float = 5.0,
    ) -> None:
        super().__init__(heartbeat_sec=heartbeat_sec)
        self._hub = hub
        self._token = token
        self._visible = False
        self._last_flush = 0.0
        self._pending: dict[str, Any] | None = None
        self._timer: threading.Timer | None = None
        self._started_at = time.monotonic()
        self._current: int | None = None
        self._total: int | None = None
        self._label = ""
        self._task_id = "task"
        self._generation = 0
        self._closed = False

    def _stop_timer_locked(self) -> None:
        timer = self._timer
        self._timer = None
        if timer is not None:
            timer.cancel()

    def _arm_timer_locked(self, delay: float, callback: Any) -> None:
        self._stop_timer_locked()
        self._generation += 1
        gen = self._generation
        timer = threading.Timer(delay, callback, args=(gen,))
        timer.daemon = True
        self._timer = timer
        timer.start()

    def _on_lazy(self, gen: int) -> None:
        with self._lock:
            if self._closed or gen != self._generation or self._visible:
                return
            self._visible = True
            self._stop_timer_locked()
            task_id = self._task_id
            label = self._label or "Activity"
            total = self._total
        self._flush(
            guest_progress_payload(
                ProgressEvent(
                    kind="start",
                    task_id=task_id,
                    label=label,
                    current=0,
                    total=total,
                    elapsed_sec=self._elapsed(),
                )
            )
        )

    def _elapsed(self) -> float:
        return max(0.0, time.monotonic() - self._started_at)

    def _flush(self, payload: dict[str, Any]) -> None:
        with self._lock:
            if self._closed:
                return
            self._last_flush = time.monotonic()
            self._pending = None
        self._hub.publish(self._token, payload)

    def _emit(self, event: ProgressEvent) -> None:
        payload = guest_progress_payload(event)
        kind = event.kind
        pending: dict[str, Any] | None = None
        with self._lock:
            if self._closed and kind not in _TERMINAL:
                return
            if kind in _TERMINAL:
                self._generation += 1
                self._stop_timer_locked()
                if not self._visible:
                    self._pending = None
                    return
                pending = self._pending
                self._pending = None
            elif not self._visible:
                if kind == "start":
                    self._task_id = event.task_id
                    self._label = event.label
                    self._total = event.total
                    self._arm_timer_locked(GUEST_PROGRESS_LAZY_SEC, self._on_lazy)
                    return
                self._visible = True
                self._stop_timer_locked()
                pending = None
            else:
                now = time.monotonic()
                if kind in _LIVE and now - self._last_flush < GUEST_PROGRESS_COALESCE_SEC:
                    self._pending = payload
                    wait = GUEST_PROGRESS_COALESCE_SEC - (now - self._last_flush)
                    self._arm_timer_locked(max(0.0, wait), self._flush_pending)
                    return
                pending = None
        if kind in _TERMINAL and pending is not None:
            self._flush(pending)
        self._flush(payload)

    def _flush_pending(self, gen: int) -> None:
        with self._lock:
            if self._closed or gen != self._generation:
                return
            payload = self._pending
            self._pending = None
            self._timer = None
            if payload is None:
                return
            self._last_flush = time.monotonic()
        self._hub.publish(self._token, payload)

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        with self._lock:
            if self._closed:
                return
            self._task_id = task_id
            self._label = label
            self._total = total
            self._current = 0
        self._register_task(task_id, label, total)
        self._emit(
            ProgressEvent(
                kind="start",
                task_id=task_id,
                label=label,
                current=0,
                total=total,
                elapsed_sec=self._elapsed(),
            )
        )

    def update(
        self,
        task_id: str,
        current: int,
        *,
        total: int | None = None,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        with self._lock:
            if self._closed:
                return
            self._current = current
            if total is not None:
                self._total = total
            label = self._label or task_id
            resolved_total = self._total
        if self._touch_task(task_id, current, total, phase) is None:
            self._register_task(task_id, label, resolved_total)
            self._touch_task(task_id, current, total, phase)
        self._emit(
            ProgressEvent(
                kind="update",
                task_id=task_id,
                label=label,
                current=current,
                total=resolved_total,
                elapsed_sec=self._elapsed(),
                message=message,
                phase=phase,
            )
        )

    def message(self, task_id: str, text: str, *, phase: str | None = None) -> None:
        with self._lock:
            if self._closed:
                return
            label = self._label or task_id
            current = self._current
            total = self._total
        self._emit(
            ProgressEvent(
                kind="message",
                task_id=task_id,
                label=label,
                current=current,
                total=total,
                elapsed_sec=self._elapsed(),
                message=text,
                phase=phase,
            )
        )

    def heartbeat(self, task_id: str, *, message: str | None = None) -> None:
        with self._lock:
            if self._closed:
                return
            label = self._label or task_id
            current = self._current
            total = self._total
        self._emit(
            ProgressEvent(
                kind="heartbeat",
                task_id=task_id,
                label=label,
                current=current,
                total=total,
                elapsed_sec=self._elapsed(),
                message=message,
            )
        )

    def end(self, task_id: str, *, message: str | None = None) -> None:
        with self._lock:
            label = self._label or task_id
            current = self._current
            total = self._total
        self._emit(
            ProgressEvent(
                kind="end",
                task_id=task_id,
                label=label,
                current=current,
                total=total,
                elapsed_sec=self._elapsed(),
                message=message,
            )
        )
        self.close()

    def fail(
        self,
        task_id: str,
        *,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        short = short_fail_headline(message, phase)
        with self._lock:
            label = self._label or task_id
            current = self._current
            total = self._total
        self._emit(
            ProgressEvent(
                kind="fail",
                task_id=task_id,
                label=label,
                current=current,
                total=total,
                elapsed_sec=self._elapsed(),
                message=short,
                phase=phase,
            )
        )
        self.close()

    def cancel(self, task_id: str, *, message: str | None = None) -> None:
        with self._lock:
            label = self._label or task_id
            current = self._current
            total = self._total
        self._emit(
            ProgressEvent(
                kind="cancel",
                task_id=task_id,
                label=label,
                current=current,
                total=total,
                elapsed_sec=self._elapsed(),
                message=message,
            )
        )
        self.close()

    def _emit_heartbeat(self, task_id: str, state: Any, elapsed_sec: float) -> None:
        del state, elapsed_sec
        self.heartbeat(task_id)

    def close(self) -> None:
        with self._lock:
            already = self._closed
            self._closed = True
            self._generation += 1
            self._stop_timer_locked()
            self._pending = None
            task_ids = list(self._tasks)
        for tid in task_ids:
            self._finish_task(tid)
        if not already:
            ElapsedProgressMixin.close(self)


def guest_ws_progress_sink(token: str) -> ProgressReporter | None:
    """Always attach so last-value replay can catch a late ReviewApp subscriber."""
    return GuestWsProgressReporter(guest_progress_hub(), token)
