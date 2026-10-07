"""Let a running MCP tool see that its client cancelled the request (#1164).

Installed once on the ``MCPServer`` like ``install_busy_errors``: wraps ``call_tool`` via
``util.mcp_call_tool.wrap_call_tool`` and binds ``render_cancel_scope`` to a flag that turns
true when the request is cancelled, so a tool reads ``current_cancel_check()`` and passes it
to the service call that can stop early (``PipelineService.export_audio``).

The SDK cancels the handler's scope when the client sends ``notifications/cancelled`` or
drops the request, and a sync tool's worker thread is never abandoned, so the tool cannot
see that cancel on its own. A watcher task in the handler's scope sets the flag when it is
cancelled. After ``notifications/cancelled`` the SDK sends no response for the request; an
in-process ``auto``-mode client that cancels its own call can still receive the tool's
result or error.
"""

from __future__ import annotations

import threading
from typing import Any

import anyio

from podcast_mcp.util.mcp_call_tool import CallNext, wrap_call_tool
from podcast_mcp.util.project_state import render_cancel_scope


async def _set_when_cancelled(stop: threading.Event) -> None:
    try:
        await anyio.sleep_forever()
    finally:
        stop.set()


def install_request_cancel(server: Any) -> None:
    """Bind each tool call's cancel check to its request's cancellation. Idempotent."""
    if getattr(server, "_podcast_request_cancel_installed", False):
        return

    async def around(
        name: str, arguments: dict[str, Any], context: Any, call_next: CallNext
    ) -> Any:
        if context is None:
            return await call_next(arguments)
        stop = threading.Event()
        try:
            async with anyio.create_task_group() as tg:
                tg.start_soon(_set_when_cancelled, stop)
                try:
                    with render_cancel_scope(stop.is_set):
                        return await call_next(arguments)
                finally:
                    tg.cancel_scope.cancel()
        except BaseExceptionGroup as group:
            # anyio wraps the tool's own error; the watcher raises nothing, so there is one.
            raise group.exceptions[0] from None

    wrap_call_tool(server, around)
    server._podcast_request_cancel_installed = True
