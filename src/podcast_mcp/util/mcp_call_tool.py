"""One forwarding wrapper for ``MCPServer.call_tool`` shared by every ``call_tool`` installer.

``install_mcp_progress`` (``util/progress.py``), ``install_busy_errors`` (``mcp/busy_errors.py``)
and ``install_host_project_injection`` (``gui/host_mcp.py``) each wrap the SDK's ``call_tool``.
This helper owns the signature and forwards ``context`` plus any extra positional / keyword
arguments, so a new SDK parameter needs one change here instead of one per installer (#488).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

CallNext = Callable[[dict[str, Any]], Awaitable[Any]]
"""Call the wrapped ``call_tool`` for the same tool with (possibly rewritten) arguments."""

CallToolAround = Callable[[str, dict[str, Any], Any, CallNext], Awaitable[Any]]
"""``around(name, arguments, context, call_next)``: the work an installer does around one call."""


def wrap_call_tool(server: Any, around: CallToolAround) -> None:
    """Replace ``server.call_tool`` with a wrapper that runs *around* for each call.

    *around* receives the tool ``name``, its ``arguments``, the request ``context`` (``None``
    outside a request) and ``call_next``. It may rewrite the arguments it passes to
    ``call_next``, return its own result without calling it, or catch what it raises. Not
    idempotent by itself: each installer keeps its own installed flag.
    """
    original_call_tool: Callable[..., Awaitable[Any]] = server.call_tool

    async def call_tool(
        name: str,
        arguments: dict[str, Any],
        context: Any = None,
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        async def call_next(next_arguments: dict[str, Any]) -> Any:
            return await original_call_tool(name, next_arguments, context, *args, **kwargs)

        return await around(name, arguments, context, call_next)

    server.call_tool = call_tool
