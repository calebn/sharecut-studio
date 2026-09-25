"""Host waveform pyramid routes: status, immutable data tiles, deep-zoom PCM.

Thin handlers over ``services/waveform``. Success bodies for tiles and PCM are
content-addressed by the pyramid key, so they are cached as immutable; every
error sends ``Cache-Control: no-store``. See ``docs/waveform.md`` § API.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

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

log = logging.getLogger(__name__)

router = APIRouter()

NO_STORE = {"Cache-Control": "no-store"}
IMMUTABLE = "private, max-age=31536000, immutable"
OCTET_STREAM_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {"description": "Raw bins", "content": {"application/octet-stream": {}}}
}

T = TypeVar("T")


def no_store_error(exc: HTTPException) -> HTTPException:
    """Copy *exc* with ``Cache-Control: no-store`` (errors must never be cached)."""
    return HTTPException(
        status_code=exc.status_code,
        detail=exc.detail,
        headers={**(exc.headers or {}), **NO_STORE},
    )


def waveform_error(exc: Exception) -> HTTPException:
    """Map service errors: stale key 409, bad input 400, anything missing 404.

    The 400 detail echoes ``str(exc)`` and guests reach this through
    ``waveform_call``: raise ``ValueError`` on waveform paths only with fixed
    messages or the caller's own input, never host paths.
    """
    if isinstance(exc, StaleWaveformKeyError):
        return HTTPException(status_code=409, detail=str(exc), headers=NO_STORE)
    if isinstance(exc, ValueError):
        return HTTPException(status_code=400, detail=str(exc), headers=NO_STORE)
    return HTTPException(status_code=404, detail="not found", headers=NO_STORE)


def binary_response(body: bytes, *, background: BackgroundTask | None = None) -> Response:
    """Immutable octet-stream. The URL carries the content-addressed pyramid key, so no ETag."""
    return Response(
        content=body,
        media_type="application/octet-stream",
        headers={"Cache-Control": IMMUTABLE},
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


def _internal_error(_exc: Exception) -> HTTPException:
    return HTTPException(status_code=500, detail="internal error")


def waveform_call(
    fn: Callable[[], T],
    *,
    fallback: Callable[[Exception], HTTPException] = _internal_error,
) -> T:
    """Run *fn*; every error leaves as an HTTPException with ``Cache-Control: no-store``.

    ``HTTPException`` keeps its status. Service errors go through ``waveform_error``.
    Anything else goes through *fallback*: guests pass ``_map_share_exc``, so a
    ``PermissionError`` from the share capability check stays 403.
    Only errors that map to 5xx are logged, so a guest's routine 403 or 404 never writes a traceback.
    """
    try:
        return fn()
    except HTTPException as exc:
        raise no_store_error(exc) from exc
    except (ValueError, LookupError, FileNotFoundError) as exc:
        raise waveform_error(exc) from exc
    except Exception as exc:
        mapped = fallback(exc)
        if mapped.status_code >= 500:
            log.exception("waveform request failed")
        raise no_store_error(mapped) from exc


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
    body = waveform_call(lambda: waveform_status(project_path, "stem" if kind == "stem" else "raw"))
    return JSONResponse(body, headers=NO_STORE)


@router.get("/api/waveform/tiles/{key}", response_class=Response, responses=OCTET_STREAM_RESPONSES)
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
    body = waveform_call(lambda: tile_bytes(project_path, ref, key, level, start, count))
    return binary_response(body)


@router.get("/api/waveform/pcm/{key}", response_class=Response, responses=OCTET_STREAM_RESPONSES)
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
    body = waveform_call(lambda: pcm_block(project_path, ref, key, block))
    return binary_response(body)
