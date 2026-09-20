from __future__ import annotations

from mcp.server import MCPServer

from podcast_mcp.services.gui_launch import ensure_viewer


def open_gui_tool(
    project_path: str,
    host: str = "127.0.0.1",
    port: int = 8765,
    open_browser: bool = True,
) -> str:
    """Start the read-only DAW web viewer (background) and return its URL.

    Idempotent: if a healthy viewer is already listening on host:port, reuses it
    and optionally opens the browser to this project. Requires the ``gui`` extra
    (``uv sync --extra gui``) and a built ``gui/web`` dist for the HTML UI.
    """
    return ensure_viewer(
        project_path,
        host=host,
        port=port,
        open_browser=open_browser,
    ).to_json()


def register(mcp: MCPServer) -> None:
    """Register GUI tools on the MCP server."""
    mcp.tool()(open_gui_tool)
