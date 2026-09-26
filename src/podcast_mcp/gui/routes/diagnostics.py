"""Host-only diagnostics bundle routes (never on the guest/share allowlist)."""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from podcast_mcp.distribution import runtime_distribution_metadata
from podcast_mcp.gui.jobs import PipelineJobManager
from podcast_mcp.gui.routes.deps import require_host, resolve_project
from podcast_mcp.services.diagnostics import (
    MAX_BUNDLE_BYTES,
    DiagnosticsService,
    default_bundle_dir,
    is_allowed_bundle_name,
    resolve_bundle_file,
)
from podcast_mcp.services.report_submission import (
    get_report_status,
    preview_bundle,
    report_relay_url,
    submit_bundle,
)
from podcast_mcp.services.workspace import ProjectWorkspace

router = APIRouter()
log = logging.getLogger(__name__)
_BUNDLES_LOCK = threading.Lock()


class DiagnosticsSubmitRequest(BaseModel):
    filename: str
    description: str
    consent: bool


class DiagnosticsBundleRequest(BaseModel):
    out_dir: str | None = Field(default=None)
    path: str | None = Field(default=None, description="Optional episode.project.json")


def _jobs(request: Request) -> PipelineJobManager | None:
    return getattr(request.app.state, "jobs", None)


def _job_snapshots(request: Request) -> list[dict[str, Any]]:
    mgr = _jobs(request)
    if mgr is None:
        return []
    return mgr.recent_snapshots(limit=10)


def _bundle_registry(request: Request) -> dict[str, str]:
    with _BUNDLES_LOCK:
        registry = getattr(request.app.state, "diagnostics_bundles", None)
        if not isinstance(registry, dict):
            registry = {}
            request.app.state.diagnostics_bundles = registry
        return registry


def _register_bundle(request: Request, filename: str, directory: Path) -> None:
    with _BUNDLES_LOCK:
        registry = getattr(request.app.state, "diagnostics_bundles", None)
        if not isinstance(registry, dict):
            registry = {}
            request.app.state.diagnostics_bundles = registry
        registry[filename] = str(directory)


def _load_project(request: Request, path: str | None):
    raw = (path or "").strip()
    if not raw:
        served = getattr(request.app.state, "served_project", None)
        if served is None:
            return None
        raw = str(served)
    project_path = resolve_project(raw, request)
    return ProjectWorkspace.open(project_path).project


@router.get("/api/diagnostics")
def diagnostics_meta(
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    metadata = runtime_distribution_metadata()
    try:
        report_relay_url()
        report_available = True
    except ValueError:
        report_available = False
    return {
        "report_available": report_available,
        "support_url": metadata.support_url,
        "privacy_url": metadata.privacy_url,
        "repository_url": metadata.repository_url,
        "release_manifest_url": metadata.release_manifest_url,
    }


@router.post("/api/diagnostics/bundle")
def create_diagnostics_bundle(
    body: DiagnosticsBundleRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, Any]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    out_dir = default_bundle_dir()
    project = _load_project(request, body.path)
    try:
        report = DiagnosticsService().build_bundle(
            project,
            out_dir=out_dir,
            job_snapshots=_job_snapshots(request),
        )
    except OSError:
        log.exception("diagnostics bundle write failed")
        raise HTTPException(status_code=400, detail="could not write diagnostics bundle") from None
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    preview = preview_bundle(report.path)
    _register_bundle(request, report.filename, report.path.parent)
    return {
        "files": list(preview.files),
        "app_version": preview.app_version,
        "created_at": preview.created_at,
        "path": str(report.path),
        "filename": report.filename,
        "support_url": report.support_url,
        "size_bytes": report.size_bytes,
    }


@router.get("/api/diagnostics/bundle/{name}")
def download_diagnostics_bundle(
    name: str,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> FileResponse:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    if not is_allowed_bundle_name(name):
        raise HTTPException(status_code=400, detail="invalid bundle filename")
    registered = _bundle_registry(request).get(name)
    if not registered:
        raise HTTPException(status_code=404, detail="bundle not found")
    path = resolve_bundle_file(name, extra_dirs=[Path(registered)])
    if path is None:
        raise HTTPException(status_code=404, detail="bundle not found")
    try:
        size = path.stat().st_size
    except OSError:
        raise HTTPException(status_code=404, detail="bundle not found") from None
    if size > MAX_BUNDLE_BYTES:
        raise HTTPException(status_code=404, detail="bundle not found")
    return FileResponse(
        path,
        media_type="application/zip",
        filename=name,
        headers={"Cache-Control": "no-store"},
    )


@router.post("/api/diagnostics/submit")
def submit_diagnostics_report(
    body: DiagnosticsSubmitRequest,
    request: Request,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, str]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    if not body.consent:
        raise HTTPException(400, "public upload consent is required")
    if not is_allowed_bundle_name(body.filename):
        raise HTTPException(400, "invalid bundle filename")
    directory = _bundle_registry(request).get(body.filename)
    if not directory:
        raise HTTPException(404, "bundle not found")
    path = resolve_bundle_file(body.filename, extra_dirs=[Path(directory)])
    if path is None:
        raise HTTPException(404, "bundle not found")
    try:
        result = submit_bundle(path, description=body.description)
        statuses: set[str] = getattr(request.app.state, "diagnostics_report_statuses", set())
        statuses.add(result["status_url"])
        request.app.state.diagnostics_report_statuses = statuses
        return result
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except (OSError, httpx.HTTPError):
        log.exception("diagnostics report forwarding failed")
        raise HTTPException(502, "report relay unavailable; use the download fallback") from None


@router.get("/api/diagnostics/report-status")
def diagnostics_report_status(
    request: Request,
    url: str,
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> dict[str, str | None]:
    require_host(request, token=token, x_podcast_token=x_podcast_token)
    statuses: set[str] = getattr(request.app.state, "diagnostics_report_statuses", set())
    if url not in statuses:
        raise HTTPException(404, "report not found")
    try:
        return get_report_status(url)
    except (ValueError, httpx.HTTPError):
        raise HTTPException(502, "report status unavailable") from None
