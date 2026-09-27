"""Per-subscriber SSE fan-out for Studio jobs (pipeline slot, agent, bootstrap).

Each ``/api/*/events`` connection subscribes its own bounded queue on a job-id-keyed
:class:`FanoutHub`, so concurrent subscribers never compete for events. Publishing never
blocks the job thread; a slow subscriber drops its own oldest events only.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any, Protocol

from podcast_mcp.services.fanout_hub import FanoutHub

JOB_EVENT_QUEUE_MAX = 256
JOB_EVENT_KEEPALIVE_SEC = 1.0
TERMINAL_JOB_STATUSES = frozenset({"ok", "error", "cancelled"})
_HUB = FanoutHub(queue_maxsize=JOB_EVENT_QUEUE_MAX)


class StreamableJob(Protocol):
    id: str

    def snapshot(self) -> dict[str, Any]: ...


def job_events_hub() -> FanoutHub:
    return _HUB


def publish_job_event(job_id: str, event: dict[str, Any]) -> None:
    """Fan *event* out to every live subscriber of *job_id*; no-op without one."""
    _HUB.publish(job_id, event)


def job_listener_count(job_id: str) -> int:
    return _HUB.listener_count(job_id)


def _frame(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload)}\n\n"


async def stream_job_events(
    job: StreamableJob, *, keepalive_sec: float = JOB_EVENT_KEEPALIVE_SEC
) -> AsyncIterator[str]:
    """SSE frames for one subscriber: connect snapshot, live events, keepalive snapshots, ``done``."""
    queue = _HUB.subscribe(job.id, asyncio.get_running_loop())
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
        _HUB.unsubscribe(job.id, queue)
