"""Host export / bounce HTTP adapters over BounceService + PipelineService."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Header, Query, Request

from podcast_mcp.gui.routes.deps import coded_exception_error, require_host, resolve_project
from podcast_mcp.gui.schemas import (
    BounceRequestBody,
    ExportDeliverablesRequest,
    TranscriptExportRequest,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TranscriptService
from podcast_mcp.services.document.transcript import ExportBusyError, TranscriptEmptyError
from podcast_mcp.services.jobs import JobManager

router = APIRouter()


def _jobs(request: Request) -> JobManager:
    return request.app.state.jobs


# Host-only gate for export jobs (bounce + deliverables): `require_host` refuses
# relay-tunneled requests even on loopback, and (under strict authz) requires
# PODCAST_SESSION_TOKEN for remote peers. See issue #219, #393 and
# docs/host-online-relay.md § Security notes.


@router.post("/api/export/bounce")
def export_bounce(
    body: BounceRequestBody,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(body.path, request)
    try:
        job = _jobs(request).start_bounce(
            project_path,
            track_ids=body.track_ids,
            start_s=body.start_s,
            end_s=body.end_s,
            formats=body.formats,
            exact_range=body.exact_range,
        )
    except RuntimeError as exc:
        raise coded_exception_error(409, exc, code="export_job_conflict") from exc
    except (ValueError, FileNotFoundError) as exc:
        raise coded_exception_error(400, exc, code="export_request_invalid") from exc
    snap = job.snapshot()
    return {"job_id": job.id, "job": snap}


@router.post("/api/export/deliverables")
def export_deliverables(
    body: ExportDeliverablesRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Same PipelineService.export_audio path used by MCP/CLI master export."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    project_path = resolve_project(body.path, request)
    try:
        job = _jobs(request).start_export(project_path, formats=body.formats)
    except RuntimeError as exc:
        raise coded_exception_error(409, exc, code="export_job_conflict") from exc
    except (ValueError, FileNotFoundError) as exc:
        raise coded_exception_error(400, exc, code="export_request_invalid") from exc
    snap = job.snapshot()
    return {"job_id": job.id, "job": snap}


@router.post("/api/transcript/export")
def export_transcript(
    body: TranscriptExportRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    """Write (or, with ``dry_run``, preview) the edited transcript. Synchronous, not a job."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    ws = ProjectWorkspace.open(resolve_project(body.path, request))
    try:
        result = TranscriptService(ws).export(
            body.formats, dry_run=body.dry_run, with_text=body.with_text
        )
    except ExportBusyError as exc:
        raise coded_exception_error(503, exc, code="export_busy") from exc
    except TranscriptEmptyError as exc:
        raise coded_exception_error(409, exc, code="transcript_empty") from exc
    except ValueError as exc:
        raise coded_exception_error(400, exc, code="export_request_invalid") from exc
    return asdict(result)


@router.get("/api/transcript/exports")
def list_exported_transcripts(
    request: Request,
    path: str = Query(...),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> list[dict[str, Any]]:
    """Transcript files already written next to the audio, with ``current`` per file."""
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    ws = ProjectWorkspace.open(resolve_project(path, request))
    return [asdict(f) for f in TranscriptService(ws).exported()]
