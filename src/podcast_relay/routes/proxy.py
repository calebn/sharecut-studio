"""Guest HTTP proxy: share, record, review API and MCP paths forwarded to the host tunnel."""

from __future__ import annotations

import asyncio
import base64
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse

from podcast_mcp.util.body_limits import (
    BodyTooLarge,
    is_record_upload_path,
    payload_too_large_response,
    read_body_capped,
    record_upload_max_part_bytes,
    relay_max_body_bytes,
)
from podcast_mcp.util.proxy_paths import proxy_path_is_safe
from podcast_mcp.util.rate_limit import is_review_audio_path
from podcast_mcp.util.rate_limit_http import rate_limited_response
from podcast_mcp.util.relay_protocol.protocol import msg, new_id
from podcast_relay.limits import check_proxy_rpm, get_relay_limiters, relay_rate_limit_enabled
from podcast_relay.offline import offline_page
from podcast_relay.state import PendingHttp, RelayState

_OFFLINE_HTML = offline_page(
    title="Host offline",
    heading="Host offline",
    body_html=(
        "<p>This review link is valid, but the project host is not connected right now.\n"
        "Ask them to run <code>podcast tunnel</code> and try again.</p>"
    ),
)

_OFFLINE_RECORD_HTML = offline_page(
    title="Studio not open yet",
    heading="Studio not open yet",
    body_html=("<p>The host isn't connected. Keep this link; try again when they are online.</p>"),
)

_HOP_BY_HOP_RESP = frozenset(
    {
        "transfer-encoding",
        "connection",
        # StreamingResponse reassembles tunnel chunks; never forward an upstream
        # Content-Length that may not match the decoded body (HTTP/2 reset).
        "content-length",
    }
)

# Where a pending-preview file sits, for the guest's A / B playheads. The same seven names as
# podcast_mcp.gui.audio.PENDING_PREVIEW_HEADER_NAMES (a test keeps the two lists equal).
_PENDING_PREVIEW_RESP_HEADERS = frozenset(
    {
        "x-preview-edit-id",
        "x-preview-mode",
        "x-preview-pad-sec",
        "x-preview-start-sec",
        "x-preview-end-sec",
        "x-preview-edit-start-sec",
        "x-preview-edit-end-sec",
    }
)

# Only these response headers may leave the relay toward guests (drop Set-Cookie).
_ALLOWED_RESP_HEADERS = _PENDING_PREVIEW_RESP_HEADERS | frozenset(
    {
        "content-type",
        "cache-control",
        "accept-ranges",
        "etag",
        "content-disposition",
        "location",
        "content-range",
        "last-modified",
        "vary",
        "retry-after",
        "x-sharecut-error-code",
        "x-robots-tag",
    }
)


def _response_headers(headers: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in headers.items():
        lk = k.lower()
        if lk in _HOP_BY_HOP_RESP:
            continue
        if lk not in _ALLOWED_RESP_HEADERS:
            continue
        out[k] = v
    return out


async def proxy_to_host(
    state: RelayState,
    request: Request,
    token: str,
    path_suffix: str,
) -> Response:
    if not proxy_path_is_safe(path_suffix):
        return JSONResponse(
            {"detail": "unsafe proxy path"},
            status_code=400,
        )

    session = state.tunnel_for_token(token)
    if session is None:
        # SPA fetches under /api/review and /mcp - return JSON so the client
        # does not render the offline HTML document as plain-text error UI.
        if (
            path_suffix.startswith(("api/review", "api/rec", "mcp"))
            or path_suffix.rstrip("/") == "r/mcp"
        ):
            return JSONResponse(
                {
                    "detail": "host offline",
                    "message": (
                        "This review link is valid, but the project host is "
                        "not connected. Ask them to run podcast tunnel."
                    ),
                },
                status_code=503,
            )
        if path_suffix.startswith("rec/"):
            return HTMLResponse(_OFFLINE_RECORD_HTML, status_code=503)
        return HTMLResponse(_OFFLINE_HTML, status_code=503)

    caps = session.capabilities.get(token) or []
    # Path-based capability gates (best-effort; host enforces too)
    mcp_path = path_suffix.startswith("mcp") or path_suffix.rstrip("/") == "r/mcp"
    if mcp_path and "mcp" not in caps:
        return JSONResponse({"detail": "share does not allow mcp"}, status_code=403)

    client_ip = request.client.host if request.client else None
    rpm = check_proxy_rpm(token=token, client_ip=client_ip, path_suffix=path_suffix)
    if not rpm.allowed:
        return rate_limited_response(rpm)

    # Hold concurrency until the proxied response finishes streaming.
    gates: list[tuple[Any, str]] = []

    def _release_gates() -> None:
        for gate, key in reversed(gates):
            gate.exit(key)

    if relay_rate_limit_enabled():
        lim = get_relay_limiters()
        if is_review_audio_path(path_suffix):
            d = lim.audio_concurrent.try_enter(token)
            if not d.allowed:
                return rate_limited_response(d)
            gates.append((lim.audio_concurrent, token))
        d = lim.token_concurrent.try_enter(token)
        if not d.allowed:
            _release_gates()
            return rate_limited_response(d)
        gates.append((lim.token_concurrent, token))
        d = lim.host_concurrent.try_enter(session.host_id)
        if not d.allowed:
            _release_gates()
            return rate_limited_response(d)
        gates.append((lim.host_concurrent, session.host_id))

    limit = relay_max_body_bytes()
    if is_record_upload_path(path_suffix):
        limit = max(limit, record_upload_max_part_bytes())
    try:
        body = await read_body_capped(request, limit)
    except BodyTooLarge:
        _release_gates()
        return payload_too_large_response(limit)

    req_id = new_id()
    pending = PendingHttp()
    session.pending[req_id] = pending
    try:
        if session.writer.closed:
            session.pending.pop(req_id, None)
            _release_gates()
            return JSONResponse({"detail": "host offline"}, status_code=503)
        await session.send(
            msg(
                "http",
                id=req_id,
                method=request.method,
                path=path_suffix,
                query=str(request.url.query or ""),
                headers={
                    k: v
                    for k, v in request.headers.items()
                    if k.lower() not in ("host", "content-length", "connection")
                },
                body_b64=base64.b64encode(body).decode("ascii") if body else "",
                share_token=token,
            )
        )
        if session.writer.closed:
            session.pending.pop(req_id, None)
            _release_gates()
            return JSONResponse({"detail": "host offline"}, status_code=503)
        try:
            await asyncio.wait_for(pending.headers_ready.wait(), timeout=300.0)
        except TimeoutError:
            session.pending.pop(req_id, None)
            _release_gates()
            return JSONResponse({"detail": "host timed out"}, status_code=504)

        out_headers = _response_headers(pending.headers)
        media = pending.headers.get("content-type") or pending.headers.get("Content-Type")

        async def _stream() -> Any:
            try:
                while True:
                    chunk = await pending.queue.get()
                    if chunk is None:
                        break
                    yield chunk
            finally:
                session.pending.pop(req_id, None)
                _release_gates()

        return StreamingResponse(
            _stream(),
            status_code=pending.status,
            headers=out_headers,
            media_type=media,
        )
    except TimeoutError:
        session.pending.pop(req_id, None)
        _release_gates()
        return JSONResponse({"detail": "host delivery timed out"}, status_code=504)
    except (asyncio.CancelledError, Exception):
        session.pending.pop(req_id, None)
        _release_gates()
        raise


def build_proxy_router(state: RelayState) -> APIRouter:
    router = APIRouter()

    @router.api_route(
        "/r/{token}",
        methods=["GET", "HEAD"],
    )
    async def share_root(token: str, request: Request) -> Response:
        return await proxy_to_host(state, request, token, "r/")

    @router.api_route(
        "/r/{token}/{path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def share_path(token: str, path: str, request: Request) -> Response:
        return await proxy_to_host(state, request, token, f"r/{path}")

    @router.api_route(
        "/rec/{token}",
        methods=["GET", "HEAD"],
    )
    async def record_root(token: str, request: Request) -> Response:
        return await proxy_to_host(state, request, token, "rec/")

    @router.api_route(
        "/rec/{token}/{path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def record_path(token: str, path: str, request: Request) -> Response:
        return await proxy_to_host(state, request, token, f"rec/{path}")

    @router.api_route(
        "/api/review/{token}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def api_review_root(token: str, request: Request) -> Response:
        return await proxy_to_host(state, request, token, "api/review/")

    @router.api_route(
        "/api/review/{token}/{path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def api_review_path(token: str, path: str, request: Request) -> Response:
        return await proxy_to_host(state, request, token, f"api/review/{path}")

    @router.api_route(
        "/api/rec/{token}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def api_rec_root(token: str, request: Request) -> Response:
        return await proxy_to_host(state, request, token, "api/rec/")

    @router.api_route(
        "/api/rec/{token}/{path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def api_rec_path(token: str, path: str, request: Request) -> Response:
        return await proxy_to_host(state, request, token, f"api/rec/{path}")

    @router.api_route(
        "/mcp/{token}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def mcp_root(token: str, request: Request) -> Response:
        return await proxy_to_host(state, request, token, "mcp/")

    @router.api_route(
        "/mcp/{token}/{path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def mcp_path(token: str, path: str, request: Request) -> Response:
        return await proxy_to_host(state, request, token, f"mcp/{path}")

    return router
