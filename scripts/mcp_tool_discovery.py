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

    # review splits core vs share tools (share mounts via the collaboration
    # extension) - same split as register_all / extensions/collaboration.py.
    registrars = (
        episode.register,
        transcript.register,
        edits.register,
        timeline.register,
        clips.register,
        comments.register,
        review.register_core,
        review.register_share,
        pipeline.register,
        history.register,
        play.register,
        record.register,
        session.register,
        ingest.register,
        speaker.register,
        gui.register,
        align.register,
    )
    names: set[str] = set()
    for register in registrars:
        fake = FakeMcp()
        register(fake)
        names.update(fake.tools)
    return names
