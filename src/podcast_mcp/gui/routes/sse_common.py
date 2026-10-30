"""Shared SSE response for Studio job event routes (pipeline + bootstrap)."""

from __future__ import annotations

from collections.abc import Callable, Collection
from pathlib import Path

from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from podcast_mcp.gui.job_events import (
    GuestStreamLease,
    StreamableJob,
    stream_guest_job_events,
    stream_job_events,
)
from podcast_mcp.services.jobs import Job

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def job_events_response(job: StreamableJob) -> StreamingResponse:
    return StreamingResponse(
        stream_job_events(job), media_type="text/event-stream", headers=SSE_HEADERS
    )


def guest_job_events_response(
    job: Job,
    project_path: Path,
    kinds: Collection[str],
    *,
    lease: GuestStreamLease,
    still_shared: Callable[[], bool],
) -> StreamingResponse:
    return StreamingResponse(
        stream_guest_job_events(job, project_path, kinds, lease=lease, still_shared=still_shared),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
        background=BackgroundTask(lease.release),
    )
