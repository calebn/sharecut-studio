"""Host-only diagnostics bundle routes (never on the guest/share allowlist)."""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from podcast_mcp.distribution import runtime_distribution_metadata
from podcast_mcp.gui.jobs import PipelineJobManager
from podcast_mcp.gui.routes.deps import peer_host, require_authz, resolve_project
from podcast_mcp.services.diagnostics import (
    MAX_BUNDLE_BYTES,
    DiagnosticsService,
    default_bundle_dir,
    is_allowed_bundle_name,
    resolve_bundle_file,
)
from podcast_mcp.services.workspace import ProjectWorkspace

router = APIRouter()
log = logging.getLogger(__name__)
_BUNDLES_LOCK = threading.Lock()


class DiagnosticsBundleRequest(BaseModel):
    out_dir: str | None = Field(default=None)
    path: str | None = Field(default=None, description="Optional episode.project.json")


def _auth(
    request: Request,
    *,
    token: str | None = None,
    x_podcast_token: str | None = None,
) -> None:
    require_authz(
        client_id="viewer",
        role="viewer",
        peer_host=peer_host(request),
        token=token or x_podcast_token,
    )


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
) -> dict[str, str | None]:
    _auth(request, token=token, x_podcast_token=x_podcast_token)
    metadata = runtime_distribution_metadata()
    return {
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
    _auth(request, token=token, x_podcast_token=x_podcast_token)
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
    _register_bundle(request, report.filename, report.path.parent)
    return {
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
    _auth(request, token=token, x_podcast_token=x_podcast_token)
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
