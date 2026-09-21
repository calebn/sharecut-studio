"""Regression coverage for the MCP tool-description catalog."""

from __future__ import annotations

from mcp.server import MCPServer

from podcast_mcp.mcp.tools import register_all


def test_every_registered_mcp_tool_has_a_description() -> None:
    """Keep every tool exposed to MCP clients discoverable in the catalog."""
    mcp = MCPServer("tool-description-inventory")
    register_all(mcp)

    tools = mcp._tool_manager.list_tools()
    missing = sorted(tool.name for tool in tools if not (tool.description or "").strip())

    assert tools
    assert not missing, "Registered MCP tools need descriptions:\n" + "\n".join(missing)
