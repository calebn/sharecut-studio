"""Test helper: tap a job's per-subscriber SSE fan-out without opening a route."""

from __future__ import annotations

import asyncio
from typing import Any

from podcast_mcp.services.jobs import job_events_hub


class JobEventTap:
    """Subscribe to a job's fan-out queue on a private loop, drain synchronously."""

    def __init__(self, job_id: str) -> None:
        self._job_id = job_id
        self._loop = asyncio.new_event_loop()
        self._queue = job_events_hub().subscribe(job_id, self._loop)

    def drain(self) -> list[dict[str, Any]]:
        delivered = self._loop.create_future()
        self._loop.call_soon(delivered.set_result, None)
        self._loop.run_until_complete(delivered)
        items: list[dict[str, Any]] = []
        while True:
            try:
                items.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        return items

    def close(self) -> None:
        job_events_hub().unsubscribe(self._job_id, self._queue)
        self._loop.close()

    def __enter__(self) -> JobEventTap:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
