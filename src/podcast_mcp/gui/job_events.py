"""SSE adapter for Studio jobs (pipeline slot, agent, bootstrap).

Each ``/api/*/events`` connection subscribes its own bounded queue on the job-id-keyed hub
that ``services/jobs/events.py`` publishes to, so concurrent subscribers never compete for
events. This module only frames those queues as server-sent events.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any, Protocol

from podcast_mcp.services.jobs import TERMINAL_JOB_STATUSES, job_events_hub

JOB_EVENT_KEEPALIVE_SEC = 1.0


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
