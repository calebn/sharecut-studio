"""JSON-RPC MCP bridge for capability-scoped guest tools (Streamable HTTP)."""

from __future__ import annotations

import json
from typing import Any

from pydantic import ValidationError

from podcast_mcp.services.remote_mcp.context import (
    RemoteMcpContext,
    clear_remote_mcp_context,
    resolve_remote_mcp_context,
    set_remote_mcp_context,
)
from podcast_mcp.services.remote_mcp.progress import GuestMcpProgressContext, McpProgressSink
from podcast_mcp.services.remote_mcp.tools import call_tool, list_tool_defs
from podcast_mcp.util.progress import (
    _mcp_progress_token,
    clear_guest_progress_context,
    set_guest_progress_context,
)

PROTOCOL_VERSION = "2024-11-05"
# Claude.ai and current MCP auth/transport eras; negotiate on initialize.
SUPPORTED_PROTOCOL_VERSIONS = frozenset(
    {
        "2024-11-05",
        "2025-03-26",
        "2025-06-18",
    }
)
SERVER_NAME = "podcast-guest-mcp"
SERVER_VERSION = "0.1.0"


def negotiate_protocol_version(requested: Any) -> str:
    """Return a supported protocol version (prefer the client's request)."""
    if isinstance(requested, str) and requested in SUPPORTED_PROTOCOL_VERSIONS:
        return requested
    return PROTOCOL_VERSION


def _result(req_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _error(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": code, "message": message},
    }


def handle_mcp_jsonrpc(
    token: str,
    message: dict[str, Any],
    *,
    progress_sink: McpProgressSink | None = None,
) -> dict[str, Any] | None:
    """Handle one MCP JSON-RPC request for *token*.

    Returns ``None`` for notifications (no response body required).
    """
    method = message.get("method")
    req_id = message.get("id")
    params = message.get("params") or {}

    if method and str(method).startswith("notifications/"):
        return None

    try:
        ctx = resolve_remote_mcp_context(token)
    except PermissionError as exc:
        return _error(req_id, -32003, str(exc))
    except (KeyError, FileNotFoundError) as exc:
        return _error(req_id, -32004, str(exc))

    set_remote_mcp_context(ctx)
    try:
        return _dispatch(ctx, method, req_id, params, progress_sink=progress_sink)
    finally:
        clear_remote_mcp_context()
        clear_guest_progress_context()


def _dispatch(
    ctx: RemoteMcpContext,
    method: str | None,
    req_id: Any,
    params: dict[str, Any],
    *,
    progress_sink: McpProgressSink | None = None,
) -> dict[str, Any]:
    if method == "initialize":
        version = negotiate_protocol_version(
            params.get("protocolVersion") if isinstance(params, dict) else None
        )
        return _result(
            req_id,
            {
                "protocolVersion": version,
                "capabilities": {
                    "tools": {"listChanged": False},
                },
                "serverInfo": {
                    "name": SERVER_NAME,
                    "version": SERVER_VERSION,
                },
            },
        )
    if method == "ping":
        return _result(req_id, {})
    if method == "tools/list":
        return _result(req_id, {"tools": list_tool_defs(ctx.capabilities)})
    if method == "tools/call":
        name = str(params.get("name") or "")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            return _error(req_id, -32602, "arguments must be an object")
        progress_token = _mcp_progress_token(params)
        mcp_ctx = (
            GuestMcpProgressContext(progress_token, sink=progress_sink)
            if progress_token is not None
            else None
        )
        set_guest_progress_context(token=ctx.token, mcp_context=mcp_ctx)
        try:
            try:
                result = call_tool(name, arguments)
            except PermissionError as exc:
                return _error(req_id, -32003, str(exc))
            except ValidationError as exc:
                return _error(req_id, -32602, str(exc))
            except TypeError as exc:
                return _error(req_id, -32602, str(exc))
            except KeyError as exc:
                return _error(req_id, -32601, str(exc))
            except Exception as exc:
                return _error(req_id, -32000, str(exc))
            text = result if isinstance(result, str) else json.dumps(result, indent=2, default=str)
            return _result(
                req_id,
                {
                    "content": [{"type": "text", "text": text}],
                    "structuredContent": result
                    if isinstance(result, (dict, list))
                    else {"result": result},
                    "isError": False,
                },
            )
        finally:
            if mcp_ctx is not None:
                mcp_ctx.close()
    return _error(req_id, -32601, f"method not found: {method}")
