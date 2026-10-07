"""JSON-RPC MCP bridge for capability-scoped guest tools (Streamable HTTP).

What a failed ``tools/call`` tells the guest (#1182), the owner server's rule
(``util/tool_refusal.py``) plus the share's own protocol errors:

* a refusal (a ``CodedError`` or a busy lock) -> an ``isError`` tool result with its message,
  host paths redacted, and ``structuredContent.error_code``, the shape the owner server returns;
* anything else is a crash -> an ``isError`` result reading ``Error executing tool <name>``,
  logged on the host with its traceback; nothing from the exception reaches the guest;
* JSON-RPC errors are for the protocol only: ``-32601`` an unknown method, ``-32602`` an unknown
  tool or arguments that do not fit it, ``-32003`` a share capability denial, ``-32004`` a share
  that no longer resolves, ``-32603`` a failure outside any tool.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from mcp.types import CallToolResult

from podcast_mcp.services.remote_mcp.context import (
    RemoteMcpContext,
    clear_remote_mcp_context,
    resolve_remote_mcp_context,
    set_remote_mcp_context,
)
from podcast_mcp.services.remote_mcp.progress import GuestMcpProgressContext, McpProgressSink
from podcast_mcp.services.remote_mcp.tools import (
    InvalidToolArgumentsError,
    UnknownToolError,
    call_tool,
    list_tool_defs,
)
from podcast_mcp.util.progress import (
    _mcp_progress_token,
    clear_guest_progress_context,
    set_guest_progress_context,
)
from podcast_mcp.util.tool_refusal import crash_tool_result, refusal_tool_result, tool_refusal

logger = logging.getLogger(__name__)

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

SHARE_NOT_FOUND = "share not found"
INTERNAL_ERROR = "internal error"


def negotiate_protocol_version(requested: Any) -> str:
    """Return a supported protocol version (prefer the client's request)."""
    if isinstance(requested, str) and requested in SUPPORTED_PROTOCOL_VERSIONS:
        return requested
    return PROTOCOL_VERSION


def _result(req_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _error(
    req_id: Any, code: int, message: str, *, data: dict[str, Any] | None = None
) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": error,
    }


def internal_error(req_id: Any) -> dict[str, Any]:
    """JSON-RPC ``-32603`` for a failure outside any tool; the caller logs the exception."""
    return _error(req_id, -32603, INTERNAL_ERROR)


def _is_capability_denial(exc: PermissionError) -> bool:
    # Share capability checks raise ``PermissionError(message)``, written for the guest. The
    # OS raises one with an errno and the host path it could not open: that is a crash.
    return exc.errno is None


# The tool-result fields guests have always received (no SDK-only extras such as resultType).
_WIRE = {"content", "structured_content", "is_error"}


def _tool_result(req_id: Any, result: CallToolResult) -> dict[str, Any]:
    return _result(
        req_id, result.model_dump(by_alias=True, exclude_none=True, mode="json", include=_WIRE)
    )


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
        if not _is_capability_denial(exc):
            logger.error("Resolving a guest MCP share failed", exc_info=exc)
            return internal_error(req_id)
        return _error(req_id, -32003, str(exc))
    except (KeyError, FileNotFoundError):
        # Revoked, expired, or its project moved: the message would name host paths.
        return _error(req_id, -32004, SHARE_NOT_FOUND)
    except Exception as exc:
        logger.error("Resolving a guest MCP share failed", exc_info=exc)
        return internal_error(req_id)

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
            except Exception as exc:
                return _tool_failure(req_id, name, exc)
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


def _tool_failure(req_id: Any, name: str, exc: Exception) -> dict[str, Any]:
    """The response to a ``tools/call`` that raised (see the module doc)."""
    if isinstance(exc, UnknownToolError):
        return _error(req_id, -32602, str(exc))
    if isinstance(exc, InvalidToolArgumentsError):
        return _error(req_id, -32602, str(exc), data={"error_code": exc.code})
    if isinstance(exc, PermissionError) and _is_capability_denial(exc):
        return _error(req_id, -32003, str(exc))
    refusal = tool_refusal(exc, for_guest=True)
    if refusal is None:
        logger.error("Guest tool %r failed", name, exc_info=exc)
        return _tool_result(req_id, crash_tool_result(name))
    # %r keeps guest-supplied text on one line, like the owner server's refusal log.
    logger.info("Guest tool %r refused (%s): %r", name, refusal.code, refusal.message)
    return _tool_result(req_id, refusal_tool_result(refusal))
