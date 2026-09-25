"""Host waveform pyramid routes: status, immutable data tiles, deep-zoom PCM.

Thin handlers over ``services/waveform``. Success bodies for tiles and PCM are
content-addressed by the pyramid key, so they are cached as immutable; every
error sends ``Cache-Control: no-store``. See ``docs/waveform.md`` § API.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import TypeVar

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from starlette.background import BackgroundTask

from podcast_mcp.gui.routes.deps import require_host, resolve_project
from podcast_mcp.services.waveform import (
    StaleWaveformKeyError,
    pcm_block,
    tile_bytes,
    waveform_status,
)

router = APIRouter()

NO_STORE = {"Cache-Control": "no-store"}
IMMUTABLE = "private, max-age=31536000, immutable"

T = TypeVar("T")


def no_store_error(exc: HTTPException) -> HTTPException:
    """Copy *exc* with ``Cache-Control: no-store`` (errors must never be cached)."""
    return HTTPException(
        status_code=exc.status_code,
        detail=exc.detail,
        headers={**(exc.headers or {}), **NO_STORE},
    )


def waveform_error(exc: Exception) -> HTTPException:
    """Map service errors: stale key 409, bad input 400, anything missing 404."""
    if isinstance(exc, StaleWaveformKeyError):
        return HTTPException(status_code=409, detail=str(exc), headers=NO_STORE)
    if isinstance(exc, ValueError):
        return HTTPException(status_code=400, detail=str(exc), headers=NO_STORE)
    return HTTPException(status_code=404, detail="not found", headers=NO_STORE)


def binary_response(
    body: bytes, etag: str, *, background: BackgroundTask | None = None
) -> Response:
    """Immutable octet-stream (the body is addressed by the pyramid key in *etag*)."""
    return Response(
        content=body,
        media_type="application/octet-stream",
        headers={"Cache-Control": IMMUTABLE, "ETag": f'"{etag}"'},
        background=background,
    )


def _host_project(
    request: Request, path: str, token: str | None, x_podcast_token: str | None
) -> Path:
    try:
        require_host(request, token=token, x_podcast_token=x_podcast_token)
        return resolve_project(path, request)
    except HTTPException as exc:
        raise no_store_error(exc) from exc


def _call(fn: Callable[[], T]) -> T:
    try:
        return fn()
    except (ValueError, LookupError, FileNotFoundError) as exc:
        raise waveform_error(exc) from exc


@router.get("/api/waveform/status")
def get_waveform_status(
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    kind: str = Query("raw", description="raw (track/source media) or stem"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> JSONResponse:
    project_path = _host_project(request, path, token, x_podcast_token)
    if kind not in ("raw", "stem"):
        raise HTTPException(status_code=400, detail="kind must be raw or stem", headers=NO_STORE)
    body = waveform_status(project_path, "stem" if kind == "stem" else "raw")
    return JSONResponse(body, headers=NO_STORE)


@router.get("/api/waveform/tiles/{key}")
def get_waveform_tiles(
    key: str,
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    ref: str = Query(..., description="track:<id>, source:<id> or stem:<id>"),
    level: int = Query(...),
    start: int = Query(..., description="First data tile"),
    count: int = Query(1, description="Data tiles (1..max_tiles_per_request)"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> Response:
    project_path = _host_project(request, path, token, x_podcast_token)
    body = _call(lambda: tile_bytes(project_path, ref, key, level, start, count))
    return binary_response(body, f"{key}-{level}-{start}-{count}")


@router.get("/api/waveform/pcm/{key}")
def get_waveform_pcm(
    key: str,
    request: Request,
    path: str = Query(..., description="Path to episode.project.json"),
    ref: str = Query(..., description="track:<id>, source:<id> or stem:<id>"),
    block: int = Query(..., description="PCM block (pcm_block_frames frames each)"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> Response:
    project_path = _host_project(request, path, token, x_podcast_token)
    body = _call(lambda: pcm_block(project_path, ref, key, block))
    return binary_response(body, f"{key}-pcm-{block}")
