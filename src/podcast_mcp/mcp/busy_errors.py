"""Turn a busy project/render lock into a structured MCP tool result, not a bare protocol
error (#488).

Installed once on the ``MCPServer`` (same choke-point pattern as ``install_mcp_progress`` /
``install_project_default``): wraps ``call_tool`` via ``util.mcp_call_tool.wrap_call_tool`` so
a ``filelock.Timeout`` raised by a tool
(``ProjectBusyError`` / ``RenderBusyError``, or a raw one such as the transcript-context
lock, #396/#401) — which the SDK would otherwise surface only as an opaque
``UnexpectedToolError`` — becomes an ``is_error`` ``CallToolResult`` with
``structured_content {ok: false, error, error_code: "project_busy"}``, so the calling agent
can see and act on it instead of the crash message alone.
"""

from __future__ import annotations

from typing import Any

from filelock import Timeout
from mcp.server.mcpserver.exceptions import UnexpectedToolError
from mcp.types import CallToolResult, TextContent

from podcast_mcp.util.mcp_call_tool import CallNext, wrap_call_tool
from podcast_mcp.util.project_state import PROJECT_BUSY_CODE, busy_message


def lock_timeout_cause(exc: BaseException) -> Timeout | None:
    """Walk ``exc`` and its ``__cause__`` chain for a ``filelock.Timeout``, else ``None``.

    Guards against a cycle (an exception should never be its own cause, but nothing
    prevents it) by tracking exceptions already seen.
    """
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        if isinstance(current, Timeout):
            return current
        seen.add(id(current))
        current = current.__cause__
    return None


def busy_tool_result(exc: Timeout) -> CallToolResult:
    """A structured, ``is_error`` result for a busy lock, instead of raising further."""
    message = busy_message(exc)
    return CallToolResult(
        content=[TextContent(type="text", text=message)],
        structured_content={"ok": False, "error": message, "error_code": PROJECT_BUSY_CODE},
        is_error=True,
    )


def install_busy_errors(server: Any) -> None:
    """Wrap ``MCPServer.call_tool`` so a busy lock returns a structured error result.

    Idempotent, like ``install_project_default``: a second call is a no-op.
    """
    if getattr(server, "_podcast_busy_errors_installed", False):
        return

    async def around(
        name: str, arguments: dict[str, Any], context: Any, call_next: CallNext
    ) -> Any:
        try:
            return await call_next(arguments)
        except UnexpectedToolError as exc:
            cause = lock_timeout_cause(exc)
            if cause is None:
                raise
            return busy_tool_result(cause)

    wrap_call_tool(server, around)
    server._podcast_busy_errors_installed = True
