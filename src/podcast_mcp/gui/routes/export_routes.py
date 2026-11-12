"""Host export / bounce HTTP adapters over BounceService + PipelineService."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict
from typing import Any

from fastapi import APIRouter, Depends, Header, Query, Request
from starlette.responses import Response

from podcast_mcp.gui.routes import export_ticket
from podcast_mcp.gui.routes.deps import (
    coded_exception_error,
    host_gate,
    refuse_relayed,
    require_host,
    resolve_project,
)
from podcast_mcp.gui.routes.export_files import (
    download_exported_file,
    list_exported_files,
    reveal_exported_file,
)
from podcast_mcp.gui.schemas import (
    BounceRequestBody,
    ExportDeliverablesRequest,
    ExportRevealRequest,
    ExportSettingsAvailable,
    ExportSettingsUnavailable,
    TranscriptExportRequest,
)
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import ExportBusyError, TranscriptEmptyError, TranscriptService
from podcast_mcp.services.jobs import JobManager
from podcast_mcp.services.pipeline import read_export_settings

router = APIRouter()
_HOST_GATE = [Depends(host_gate)]


def _jobs(request: Request) -> JobManager:
    return request.app.state.jobs


# Host-only gate for export jobs (bounce + deliverables): `require_host` refuses
# relay-tunneled requests even on loopback, and (under strict authz) requires
# PODCAST_SESSION_TOKEN for remote peers. See issue #219, #393 and
# docs/host-online-relay.md § Security notes.


@router.post("/api/export/bounce", dependencies=_HOST_GATE)
def export_bounce(
    body: BounceRequestBody,
    request: Request,
) -> dict[str, Any]:
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


@router.post("/api/export/deliverables", dependencies=_HOST_GATE)
def export_deliverables(
    body: ExportDeliverablesRequest,
    request: Request,
) -> dict[str, Any]:
    project_path = resolve_project(body.path, request)
    try:
        job = _jobs(request).start_export(project_path, formats=body.formats, target=body.target)
    except RuntimeError as exc:
        raise coded_exception_error(409, exc, code="export_job_conflict") from exc
    except (ValueError, FileNotFoundError) as exc:
        raise coded_exception_error(400, exc, code="export_request_invalid") from exc
    snap = job.snapshot()
    return {"job_id": job.id, "job": snap}


@router.post(
    "/api/export/deliverables/settings",
    dependencies=_HOST_GATE,
    response_model=ExportSettingsAvailable | ExportSettingsUnavailable,
)
def export_settings(
    body: ExportDeliverablesRequest,
    request: Request,
    response: Response,
) -> Mapping[str, object]:
    project_path = resolve_project(body.path, request)
    response.headers["Cache-Control"] = "no-store"
    return read_export_settings(project_path, body.formats, body.target)


@router.post("/api/transcript/export", dependencies=_HOST_GATE)
def export_transcript(
    body: TranscriptExportRequest,
    request: Request,
) -> dict[str, Any]:
    """Write (or, with ``dry_run``, preview) the edited transcript. Synchronous, not a job."""
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


@router.get("/api/transcript/exports", dependencies=_HOST_GATE)
def list_exported_transcripts(
    request: Request,
    path: str = Query(...),
) -> list[dict[str, Any]]:
    """Transcript files already written next to the audio, with ``current`` per file."""
    ws = ProjectWorkspace.open(resolve_project(path, request))
    return [asdict(f) for f in TranscriptService(ws).exported()]


@router.get("/api/export/files", dependencies=_HOST_GATE)
def list_export_files(
    request: Request,
    path: str = Query(...),
) -> dict[str, Any]:
    """Every file the export folder holds that an export wrote, by id; no host paths."""
    return list_exported_files(
        ProjectWorkspace.open(resolve_project(path, request)), ticketed=True, bounces=True
    )


@router.head("/api/export/files/{file_id:path}", include_in_schema=False)
@router.get("/api/export/files/{file_id:path}")
def download_export_file(
    file_id: str,
    request: Request,
    path: str = Query(...),
    token: str | None = Query(None),
    ticket: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> Response:
    """Download one listed file as an attachment. The id is checked against the listing.

    A ticket from the listing stands in for the host session token, for this file only.
    """
    ticket_version = None
    if ticket is None:
        require_host(request, token=token, x_podcast_token=x_podcast_token)
    else:
        refuse_relayed(request)
        ticket_version = export_ticket.verified_version(ticket, path, file_id)
    ws = ProjectWorkspace.open(resolve_project(path, request))
    return download_exported_file(request, ws, file_id, ticket_version=ticket_version, bounces=True)


@router.post("/api/export/files/reveal", dependencies=_HOST_GATE)
def reveal_export_file(
    body: ExportRevealRequest,
    request: Request,
) -> dict[str, bool]:
    """Show one listed file in this computer's file manager (the desktop app's Reveal)."""
    ws = ProjectWorkspace.open(resolve_project(body.path, request))
    return reveal_exported_file(request, ws, body.id)
