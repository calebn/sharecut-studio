"""Shared SSE response for Studio job event routes (pipeline + bootstrap)."""

from __future__ import annotations

from fastapi.responses import StreamingResponse

from podcast_mcp.gui.job_events import StreamableJob, stream_job_events

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def job_events_response(job: StreamableJob) -> StreamingResponse:
    return StreamingResponse(
        stream_job_events(job), media_type="text/event-stream", headers=SSE_HEADERS
    )
