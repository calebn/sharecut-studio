"""Host Split speakers HTTP adapter over ``SpeakerService`` (as a pipeline-slot job)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Query, Request

from podcast_mcp.gui.routes.deps import (
    coded_exception_error,
    coded_http_error,
    require_host,
    resolve_project,
)
from podcast_mcp.gui.schemas import SpeakerMoveLaneSpanRequest, SpeakerSplitRequest
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.jobs import JobManager
from podcast_mcp.services.media import SpeakerService
from podcast_mcp.util.coded_error import CodedValueError
from podcast_mcp.util.model_missing import ModelMissing

router = APIRouter()


@router.get("/api/speaker/doctor")
def speaker_doctor(
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Report whether this host can import a speaker recognition backend."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    return SpeakerService.doctor_static()


def _jobs(request: Request) -> JobManager:
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
            enrollment=body.enrollment,
        )
    except ModelMissing:
        raise
    except CodedValueError as exc:
        if exc.code != "speaker_backend_unavailable":
            raise coded_http_error(400, str(exc), code=exc.code) from exc
        raise coded_http_error(409, str(exc), code=exc.code) from exc
    except (RuntimeError, ImportError) as exc:
        raise coded_exception_error(409, exc, code="speaker_split_unavailable") from exc
    except (ValueError, FileNotFoundError) as exc:
        raise coded_exception_error(400, exc, code="speaker_split_invalid") from exc
    return {"job": job.snapshot()}


@router.post("/api/speaker/move-lane-span")
def speaker_move_lane_span(
    body: SpeakerMoveLaneSpanRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Move a timeline range from one speaker-split lane to a sibling lane."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(body.path, request)
    ws = ProjectWorkspace.open(project_path)
    try:
        return SpeakerService(ws).move_lane_span(
            body.from_lane,
            body.to_lane,
            timeline_start=body.timeline_start,
            timeline_end=body.timeline_end,
        )
    except CodedValueError as exc:
        raise coded_http_error(400, str(exc), code=exc.code) from exc
