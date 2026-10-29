"""Host waveform pyramid routes: status, immutable data tiles, deep-zoom PCM.

Thin handlers over ``services/waveform``. Success bodies for tiles and PCM are
content-addressed by the pyramid key, so they are cached as immutable; every
error sends ``Cache-Control: no-store``. A busy PCM decoder is 503 with
``Retry-After``. See ``docs/waveform.md`` § API.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from filelock import Timeout
from starlette.background import BackgroundTask

from podcast_mcp.gui.routes.deps import (
    ERROR_CODE_HEADER,
    NO_STORE,
    coded_http_error,
    guard_http_error,
    require_host,
    resolve_project,
)
from podcast_mcp.services.media import (
    StaleWaveformKeyError,
    WaveformBusyError,
    pcm_block,
    tile_bytes,
    waveform_status,
)
from podcast_mcp.util.coded_error import CodedError, GuardRefusal

log = logging.getLogger(__name__)

router = APIRouter()

IMMUTABLE = "private, max-age=31536000, immutable"
OCTET_STREAM_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {"description": "Raw bins", "content": {"application/octet-stream": {}}}
}

T = TypeVar("T")


def no_store_error(exc: HTTPException | GuardRefusal) -> HTTPException:
    """Copy *exc* (an auth guard's refusal included) with ``Cache-Control: no-store``."""
    if isinstance(exc, GuardRefusal):
        exc = guard_http_error(exc)
    headers = exc.headers or {}
    return coded_http_error(
        exc.status_code,
        exc.detail,
        code=headers.get(ERROR_CODE_HEADER, "request_refused"),
        headers={**headers, **NO_STORE},
    )


def _coded(exc: Exception, fallback: str) -> str:
    return exc.code if isinstance(exc, CodedError) else fallback


def waveform_error(exc: Exception) -> HTTPException:
    """Map service errors: busy decoder 503 with ``Retry-After``, stale key 409,
    bad input 400, anything missing 404.
    """
    if isinstance(exc, WaveformBusyError):
        return coded_http_error(
            503,
            "waveform decoder busy",
            code=exc.code,
            headers={**NO_STORE, "Retry-After": exc.retry_after},
        )
    if isinstance(exc, StaleWaveformKeyError):
        return coded_http_error(409, str(exc), code=exc.code, headers=NO_STORE)
    if isinstance(exc, ValueError):
        return coded_http_error(
            400, str(exc), code=_coded(exc, "invalid_request"), headers=NO_STORE
        )
    return coded_http_error(
        404, "not found", code=_coded(exc, "waveform_not_found"), headers=NO_STORE
    )


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
    except (HTTPException, GuardRefusal) as exc:
        raise no_store_error(exc) from exc


def waveform_call(fn: Callable[[], T]) -> T:
    try:
        return fn()
    except (HTTPException, GuardRefusal) as exc:
        raise no_store_error(exc) from exc
    except (ValueError, LookupError, FileNotFoundError, WaveformBusyError) as exc:
        raise waveform_error(exc) from exc
    except Timeout:
        raise
    except Exception as exc:
        log.exception("waveform request failed")
        raise no_store_error(
            coded_http_error(500, "internal error", code="internal_error")
        ) from exc


@router.get("/api/waveform/status")
def get_waveform_status(
    request: Request,
    path: str = Query(..., description="Path to episode.sharecut"),
    kind: str = Query("raw", description="raw (track/source media) or stem"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> JSONResponse:
    project_path = _host_project(request, path, token, x_podcast_token)
    if kind not in ("raw", "stem"):
        raise coded_http_error(
            400, "kind must be raw or stem", code="waveform_kind_invalid", headers=NO_STORE
        )
    body = waveform_call(lambda: waveform_status(project_path, "stem" if kind == "stem" else "raw"))
    return JSONResponse(body.model_dump(mode="json"), headers=NO_STORE)


@router.get("/api/waveform/tiles/{key}", response_class=Response, responses=OCTET_STREAM_RESPONSES)
def get_waveform_tiles(
    key: str,
    request: Request,
    path: str = Query(..., description="Path to episode.sharecut"),
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
    path: str = Query(..., description="Path to episode.sharecut"),
    ref: str = Query(..., description="track:<id>, source:<id> or stem:<id>"),
    block: int = Query(..., description="PCM block (pcm_block_frames frames each)"),
    token: str | None = Query(None),
    x_podcast_token: str | None = Header(None, alias="X-Podcast-Token"),
) -> Response:
    project_path = _host_project(request, path, token, x_podcast_token)
    body = waveform_call(lambda: pcm_block(project_path, ref, key, block))
    return binary_response(body)
