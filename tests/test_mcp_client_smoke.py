"""In-memory MCP Client smoke against the host MCPServer."""

from __future__ import annotations

import pytest

pytest.importorskip("mcp.client")


@pytest.mark.asyncio
async def test_inmemory_client_lists_host_tools() -> None:
    from mcp.client import Client

    from podcast_mcp.mcp.server import mcp

    async with Client(mcp) as client:
        result = await client.list_tools()
    names = {t.name for t in result.tools}
    assert "create_review_share_tool" in names or any("review" in n or "share" in n for n in names)
    assert len(names) >= 10
