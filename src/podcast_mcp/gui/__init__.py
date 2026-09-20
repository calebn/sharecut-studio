"""Read-only DAW-style web viewer for episode projects."""

from podcast_mcp.gui.assembler import (
    ViewProjection,
    build_project_view,
    dump_project_projection,
)
from podcast_mcp.gui.mapper import map_pending_edits_to_timeline

__all__ = [
    "ViewProjection",
    "build_project_view",
    "create_app",
    "dump_project_projection",
    "map_pending_edits_to_timeline",
]


def create_app(*args, **kwargs):
    from podcast_mcp.gui.server import create_app as _create_app

    return _create_app(*args, **kwargs)
