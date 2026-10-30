"""SSE adapter for Studio jobs (pipeline slot, agent, bootstrap).

Each ``/api/*/events`` connection subscribes its own bounded queue on the job-id-keyed hub
that ``services/jobs/events.py`` publishes to, so concurrent subscribers never compete for
events. This module only frames those queues as server-sent events.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import threading
import time
from collections.abc import AsyncIterator, Callable, Collection
from pathlib import Path
from typing import Any, Protocol

from podcast_mcp.services.jobs import (
    TERMINAL_JOB_STATUSES,
    AgentJobFanInReporter,
    Job,
    SsePublishReporter,
    guest_job_done,
    guest_job_view,
    job_events_hub,
    shared_job_manager,
    studio_job_manager,
)

JOB_EVENT_KEEPALIVE_SEC = 1.0
GUEST_STREAMS_PER_SHARE = 4
GUEST_STREAM_MAX_SEC = 3600.0
GUEST_SHARE_RECHECK_SEC = 5.0


class StreamableJob(Protocol):
    id: str

    def snapshot(self) -> dict[str, Any]: ...


def _frame(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}\n\n"


async def stream_job_events(
    job: StreamableJob, *, keepalive_sec: float = JOB_EVENT_KEEPALIVE_SEC
) -> AsyncIterator[str]:
    """SSE frames for one subscriber: connect snapshot, live events, keepalive snapshots, ``done``."""
    hub = job_events_hub()
    queue = hub.subscribe(job.id, asyncio.get_running_loop())
    try:
        snap = job.snapshot()  # after subscribe: nothing published from here on is missed
        yield _frame({"type": "status", "job": snap})
        if snap["status"] in TERMINAL_JOB_STATUSES:
            yield _frame({"type": "done", "job": snap})
            return
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=keepalive_sec)
            except TimeoutError:
                late = job.snapshot()
                if late["status"] in TERMINAL_JOB_STATUSES:
                    yield _frame({"type": "done", "job": late})
                    return
                yield _frame({"type": "status", "job": late})
                continue
            yield _frame(item)
            if item.get("type") == "done":
                return
    finally:
        hub.unsubscribe(job.id, queue)


class GuestStreamLease:
    """One open guest stream's slot; releasing twice is harmless."""

    def __init__(self, slots: GuestStreamSlots, token: str) -> None:
        self._slots = slots
        self._token = token
        self._held = True

    def release(self) -> None:
        if self._held:
            self._held = False
            self._slots._release(self._token)


class GuestStreamSlots:
    """Live guest event streams per share token, so one link cannot hold the host's connections."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._open: dict[str, int] = {}

    def acquire(self, token: str) -> GuestStreamLease | None:
        with self._lock:
            if self._open.get(token, 0) >= GUEST_STREAMS_PER_SHARE:
                return None
            self._open[token] = self._open.get(token, 0) + 1
        return GuestStreamLease(self, token)

    def _release(self, token: str) -> None:
        with self._lock:
            left = self._open.get(token, 0) - 1
            if left > 0:
                self._open[token] = left
            else:
                self._open.pop(token, None)


GUEST_STREAM_SLOTS = GuestStreamSlots()


async def stream_guest_job_events(
    job: Job,
    project_path: Path,
    kinds: Collection[str],
    *,
    lease: GuestStreamLease,
    still_shared: Callable[[], bool],
    keepalive_sec: float = JOB_EVENT_KEEPALIVE_SEC,
    max_sec: float = GUEST_STREAM_MAX_SEC,
    recheck_sec: float = GUEST_SHARE_RECHECK_SEC,
) -> AsyncIterator[str]:
    """Guest SSE frames: the fixed-copy projection only, re-checked against the job and share.

    The stream ends when the job ends, the link or project changes, or ``max_sec`` passes;
    a client reconnects for a fresh snapshot. The caller's *lease* is released on every exit.
    """
    hub = job_events_hub()
    queue = None
    try:
        queue = hub.subscribe(job.id, asyncio.get_running_loop())
        started = last_check = time.monotonic()
        while True:
            view = guest_job_view(job, project_path, kinds)
            if view is None:
                return
            done = guest_job_done(job)
            yield _frame({"type": "done" if done else "status", "job": view})
            if done:
                return
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(queue.get(), timeout=keepalive_sec)
            now = time.monotonic()
            if now - started >= max_sec:
                return
            if now - last_check >= recheck_sec:
                last_check = now
                if not await asyncio.to_thread(still_shared):
                    return
    finally:
        if queue is not None:
            hub.unsubscribe(job.id, queue)
        lease.release()


def gui_sse_progress_sink() -> SsePublishReporter | None:
    """Live in-process SSE fan-out; no job field writes."""
    return shared_job_manager().listening_progress_reporter()


def gui_agent_job_progress_sink() -> AgentJobFanInReporter | None:
    """Wrap-level MCP/CLI fan-in. None until Studio ``create_app`` registered a manager."""
    manager = studio_job_manager()
    return None if manager is None else AgentJobFanInReporter(manager)
