"""The MCP boundary for tool failures: refusals keep their message, crashes stay generic.

mcp 2.x ``Tool.run`` passes an exception's text to the client only for ``ToolError``; anything
else becomes ``UnexpectedToolError("Error executing tool <name>")`` with the original as its
``__cause__``, and ``MCPServer`` logs it with its traceback. Our services raise domain errors,
not ``ToolError``, so without this boundary every refusal reached the agent as that bare line
(#488, #1178).

``install_tool_errors`` wraps ``MCPServer.call_tool`` once (same choke-point pattern as
``install_mcp_progress`` / ``install_project_default``, via ``util.mcp_call_tool.wrap_call_tool``)
and turns two causes into an ``is_error`` ``CallToolResult`` whose text is the message and
whose ``structured_content`` is ``{ok: false, error, error_code}``:

* a ``filelock.Timeout`` (``ProjectBusyError`` / ``RenderBusyError``, or a raw one such as the
  transcript-context lock, #396/#401) -> ``error_code: "project_busy"``;
* a ``CodedError`` (``util/coded_error.py``: a stale guard, an unknown id, an out-of-range
  index, a missing file or project, ``no_mix`` ...) -> its own ``code``.

Anything else is a bug: it is re-raised unchanged, so the SDK logs it and the agent sees
only ``Error executing tool <name>``. A domain refusal that still reaches the agent bare is
raised as a plain builtin; raise it as a ``CodedError`` instead of catching it in the tool.
"""

from __future__ import annotations

import logging
from typing import Any

from filelock import Timeout
from mcp.server.mcpserver.exceptions import UnexpectedToolError
from mcp.types import CallToolResult, TextContent

from podcast_mcp.util.coded_error import coded_cause
from podcast_mcp.util.mcp_call_tool import CallNext, wrap_call_tool
from podcast_mcp.util.project_state import PROJECT_BUSY_CODE, busy_message

logger = logging.getLogger(__name__)


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


def refusal_tool_result(message: str, code: str) -> CallToolResult:
    """A structured ``is_error`` result: the message as text, plus ``error_code``."""
    return CallToolResult(
        content=[TextContent(type="text", text=message)],
        structured_content={"ok": False, "error": message, "error_code": code},
        is_error=True,
    )


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
            busy = lock_timeout_cause(exc)
            if busy is not None:
                return refusal_tool_result(busy_message(busy), PROJECT_BUSY_CODE)
            refusal = coded_cause(exc)
            if refusal is None:
                raise
            # %r keeps caller-supplied text on one line, like the SDK's own ToolError log.
            logger.info("Tool %r refused (%s): %r", name, refusal.code, str(refusal))
            return refusal_tool_result(str(refusal), refusal.code)

    wrap_call_tool(server, around)
    server._podcast_tool_errors_installed = True
