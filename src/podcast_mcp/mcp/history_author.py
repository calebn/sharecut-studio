"""Stamp every history step an MCP tool writes as the agent's.

Installed once on the ``MCPServer`` that serves both stdio and the GUI's ``/mcp`` route,
so a tool's writes record ``agent`` wherever the server runs, not ``host``.
"""

from __future__ import annotations

from typing import Any

from podcast_mcp.project.history.author import AGENT_AUTHOR, history_author
from podcast_mcp.util.mcp_call_tool import CallNext, wrap_call_tool


def install_history_author(server: Any) -> None:
    if getattr(server, "_podcast_history_author_installed", False):
        return

    async def around(
        name: str, arguments: dict[str, Any], context: Any, call_next: CallNext
    ) -> Any:
        with history_author(AGENT_AUTHOR):
            return await call_next(arguments)

    wrap_call_tool(server, around)
    server._podcast_history_author_installed = True
