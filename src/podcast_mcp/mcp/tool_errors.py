"""The MCP boundary for tool failures: refusals keep their message, crashes stay generic.

mcp 2.x ``Tool.run`` passes an exception's text to the client only for ``ToolError``; anything
else becomes ``UnexpectedToolError("Error executing tool <name>")`` with the original as its
``__cause__``, and ``MCPServer`` logs it with its traceback. Our services raise domain errors,
not ``ToolError``, so without this boundary every refusal reached the agent as that bare line
(#488, #1178).

``install_tool_errors`` wraps ``MCPServer.call_tool`` once (same choke-point pattern as
``install_mcp_progress`` / ``install_project_default``, via ``util.mcp_call_tool.wrap_call_tool``)
and applies ``util.tool_refusal``, the rule guest remote MCP shares (#1182): a busy lock
(``project_busy``) or a ``CodedError`` (its own ``code``) becomes an ``is_error``
``CallToolResult`` whose text is the message and whose ``structured_content`` is
``{ok: false, error, error_code}``.

Anything else is a bug: it is re-raised unchanged, so the SDK logs it and the agent sees
only ``Error executing tool <name>``. A domain refusal that still reaches the agent bare is
raised as a plain builtin; raise it as a ``CodedError`` instead of catching it in the tool.
"""

from __future__ import annotations

import logging
from typing import Any

from mcp.server.mcpserver.exceptions import UnexpectedToolError

from podcast_mcp.util.mcp_call_tool import CallNext, wrap_call_tool
from podcast_mcp.util.tool_refusal import refusal_tool_result, tool_refusal

logger = logging.getLogger(__name__)


def install_tool_errors(server: Any) -> None:
    """Wrap ``MCPServer.call_tool`` so a busy lock or a refusal returns a structured result.

    Idempotent, like ``install_project_default``: a second call is a no-op.
    """
    if getattr(server, "_podcast_tool_errors_installed", False):
        return

    async def around(
        name: str, arguments: dict[str, Any], context: Any, call_next: CallNext
    ) -> Any:
        try:
            return await call_next(arguments)
        except UnexpectedToolError as exc:
            refusal = tool_refusal(exc)
            if refusal is None:
                raise
            # %r keeps caller-supplied text on one line, like the SDK's own ToolError log.
            logger.info("Tool %r refused (%s): %r", name, refusal.code, refusal.message)
            return refusal_tool_result(refusal)

    wrap_call_tool(server, around)
    server._podcast_tool_errors_installed = True
