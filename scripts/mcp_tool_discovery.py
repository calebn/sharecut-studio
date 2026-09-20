"""Shared MCP tool-name discovery for compliance / capabilities scripts."""

from __future__ import annotations


def discover_mcp_tool_names() -> set[str]:
    from podcast_mcp.mcp.tools import (
        align,
        clips,
        comments,
        edits,
        episode,
        gui,
        history,
        ingest,
        pipeline,
        play,
        record,
        review,
        session,
        speaker,
        timeline,
        transcript,
    )

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

    modules = (
        episode,
        transcript,
        edits,
        timeline,
        clips,
        comments,
        review,
        pipeline,
        history,
        play,
        record,
        review,
        session,
        ingest,
        speaker,
        gui,
        align,
    )
    names: set[str] = set()
    for mod in modules:
        fake = FakeMcp()
        mod.register(fake)
        names.update(fake.tools)
    return names
