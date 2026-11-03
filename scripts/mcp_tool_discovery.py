"""Shared MCP tool-name discovery for compliance / capabilities scripts."""

from __future__ import annotations

from typing import Any, cast


def discover_mcp_tool_names() -> set[str]:
    """Every tool ``register_all`` mounts, so a new tool module cannot be missed here."""
    from podcast_mcp.mcp.tools import register_all

    class FakeMcp:
        def __init__(self) -> None:
            self.tools: list[str] = []

        def tool(self, *args, **kwargs):
            def deco(fn):
                self.tools.append(fn.__name__)
                return fn

            return deco

        def add_tool(self, fn, name=None, **kwargs):
            self.tools.append(name or fn.__name__)

    fake = FakeMcp()
    register_all(cast(Any, fake))
    return set(fake.tools)
