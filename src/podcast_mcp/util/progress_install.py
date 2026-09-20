"""Install progress choke-point wraps for MCP / CLI / guest adapters."""

from __future__ import annotations

from typing import Any

from podcast_mcp.util.progress import (
    install_cli_progress,
    install_guest_tool_progress,
    install_mcp_progress,
)

__all__ = [
    "install_all_progress_adapters",
    "install_cli_progress",
    "install_guest_tool_progress",
    "install_mcp_progress",
]


def install_all_progress_adapters(*, mcp: Any = None, cli_app: Any = None) -> None:
    if mcp is not None:
        install_mcp_progress(mcp)
    if cli_app is not None:
        install_cli_progress(cli_app)
