"""Host Split speakers HTTP adapter over ``SpeakerService`` (as a pipeline-slot job)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request

from podcast_mcp.gui.jobs import PipelineJobManager
from podcast_mcp.gui.routes.deps import require_host, resolve_project
from podcast_mcp.gui.schemas import SpeakerSplitRequest

router = APIRouter()


def _jobs(request: Request) -> PipelineJobManager:
    return request.app.state.jobs


@router.post("/api/speaker/split")
def speaker_split(
    body: SpeakerSplitRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Start a ``kind=split_speakers`` job; its result is ``SpeakerService.split_speakers``'s."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(body.path, request)
    try:
        job = _jobs(request).start_split_speakers(
            project_path,
            track_id=body.track_id,
            speaker_count=body.speaker_count,
            names=body.names,
        )
    except (RuntimeError, ImportError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"job": job.snapshot()}
