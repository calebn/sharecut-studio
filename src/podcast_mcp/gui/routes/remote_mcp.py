"""Remote MCP routes - token-gated Streamable HTTP JSON/SSE bridge.

Active only when ``PODCAST_REMOTE_MCP=1``. Tools are capability-filtered to match
the share recipient (not the full host stdio MCP surface).

Public URL: ``/mcp/{token}/mcp`` (printed ``mcp_url``).
Compatibility alias: ``/r/{token}/mcp`` (share URL + ``/mcp``).
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from podcast_mcp.services.remote_mcp.limits import (
    check_host_bucket,
    classify_mcp_rpc,
    mcp_rate_limit_error,
    rate_limit_detail,
)
from podcast_mcp.services.remote_mcp.progress import iter_mcp_sse, rpc_progress_token
from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc
from podcast_mcp.services.share import share_allows_mcp
from podcast_mcp.util.body_limits import (
    BodyTooLarge,
    payload_too_large_response,
    read_body_capped,
    remote_mcp_max_body_bytes,
)

router = APIRouter()

_MCP_ACCEPT = "application/json"


def _require_mcp_capability(token: str) -> None:
    """Raise HTTP 403/404 if the token is invalid or lacks the ``mcp`` capability."""
    try:
        allowed = share_allows_mcp(token)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not allowed:
        raise HTTPException(status_code=403, detail="share does not allow mcp")


def _remote_mcp_enabled() -> bool:
    return bool(os.environ.get("PODCAST_REMOTE_MCP"))


def _rate_limit_http(token: str, kind: str) -> None:
    decision = check_host_bucket(token, kind)
    if not decision.allowed:
        raise HTTPException(
            status_code=429,
            detail=rate_limit_detail(decision),
            headers={"Retry-After": decision.retry_after_header},
        )


def accept_allows_json_rpc(accept: str) -> bool:
    """True when Claude/Cursor-style Accept headers should be allowed."""
    if not accept or accept.strip() == "*/*":
        return True
    lower = accept.lower()
    return _MCP_ACCEPT in lower or "text/event-stream" in lower or "*/*" in lower or "json" in lower


@router.get("/mcp/{token}")
def mcp_info(token: str) -> dict[str, Any]:
    """Return capability info for the token; 403 if mcp is not granted."""
    _require_mcp_capability(token)
    _rate_limit_http(token, "read")
    return {
        "ok": True,
        "token": token,
        "remote_mcp_enabled": _remote_mcp_enabled(),
        "mcp_path": f"/mcp/{token}/mcp",
        "mcp_alias_path": f"/r/{token}/mcp",
        "transport": "streamable-http-json",
        "note": (
            "POST JSON-RPC to mcp_path (printed MCP URL) with Accept: application/json "
            "(Claude also sends text/event-stream). "
            "mcp_alias_path is the same bridge when a client appends /mcp to the share URL. "
            "Tools are filtered to this share's capabilities. "
            "Link shares are authless (coolname in the URL); leave OAuth blank "
            "in Claude custom connectors."
        ),
    }


@router.api_route(
    "/mcp/{token}/mcp",
    methods=["GET", "POST", "OPTIONS"],
)
@router.api_route(
    "/r/{token}/mcp",
    methods=["GET", "POST", "OPTIONS"],
)
async def mcp_bridge(token: str, request: Request) -> Any:
    """Capability-scoped guest MCP endpoint (JSON-RPC over Streamable HTTP)."""
    _require_mcp_capability(token)
    if not _remote_mcp_enabled():
        return JSONResponse(
            {
                "detail": (
                    "remote MCP not enabled on this host; set PODCAST_REMOTE_MCP=1 to activate"
                )
            },
            status_code=501,
        )

    if request.method == "OPTIONS":
        return Response(
            status_code=204,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": (
                    "Content-Type, Accept, Authorization, Mcp-Session-Id"
                ),
            },
        )

    if request.method == "GET":
        _rate_limit_http(token, "read")
        return JSONResponse(
            {
                "ok": True,
                "transport": "streamable-http-json",
                "hint": "POST JSON-RPC messages (initialize, tools/list, tools/call)",
            }
        )

    accept = request.headers.get("accept", "")
    if not accept_allows_json_rpc(accept):
        return JSONResponse(
            {
                "jsonrpc": "2.0",
                "id": "server-error",
                "error": {
                    "code": -32600,
                    "message": (
                        "Not Acceptable: Client must accept application/json or text/event-stream"
                    ),
                },
            },
            status_code=406,
        )

    try:
        import json

        raw = await read_body_capped(request, remote_mcp_max_body_bytes())
        body = json.loads(raw.decode("utf-8"))
    except BodyTooLarge:
        return payload_too_large_response(remote_mcp_max_body_bytes())
    except Exception as exc:
        raise HTTPException(status_code=400, detail="invalid JSON body") from exc

    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="JSON-RPC body must be an object")

    params = body.get("params") or {}
    tool_name = None
    if isinstance(params, dict):
        raw_name = params.get("name")
        tool_name = raw_name if isinstance(raw_name, str) else None
    kind = classify_mcp_rpc(body.get("method"), tool_name)
    decision = check_host_bucket(token, kind)
    if not decision.allowed:
        return JSONResponse(
            mcp_rate_limit_error(body.get("id"), decision),
            status_code=429,
            headers={"Retry-After": decision.retry_after_header},
            media_type="application/json",
        )

    if rpc_progress_token(body) is not None:
        return StreamingResponse(
            iter_mcp_sse(token, body),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache"},
        )

    response = handle_mcp_jsonrpc(token, body)
    if response is None:
        return Response(status_code=202)
    return JSONResponse(response, media_type="application/json")
