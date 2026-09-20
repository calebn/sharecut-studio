from __future__ import annotations

from mcp.server import MCPServer

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


def register_all(mcp: MCPServer) -> None:
    episode.register(mcp)
    transcript.register(mcp)
    align.register(mcp)
    edits.register(mcp)
    timeline.register(mcp)
    clips.register(mcp)
    comments.register(mcp)
    review.register_core(mcp)
    pipeline.register(mcp)
    history.register(mcp)
    play.register(mcp)
    record.register(mcp)
    session.register(mcp)
    ingest.register(mcp)
    speaker.register(mcp)
    gui.register(mcp)
    from podcast_mcp.extensions.loader import load_extensions

    registry = load_extensions()
    for registrar in registry.mcp_registrars:
        registrar(mcp)
