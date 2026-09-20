"""MCP tools for conversation-align accept gate."""

from __future__ import annotations

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.services import AlignAcceptService, ProjectWorkspace


def align_status_tool(project_path: str) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(AlignAcceptService(ws).status())


def align_brief_tool(project_path: str) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(AlignAcceptService(ws).brief())


def align_done_tool(project_path: str, notes: str | None = None) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(AlignAcceptService(ws).mark_done(notes=notes, source="mcp"))


def align_waive_tool(project_path: str, reason: str) -> str:
    ws = ProjectWorkspace.open(project_path)
    return to_json(AlignAcceptService(ws).waive(reason=reason, source="mcp"))


def register(mcp) -> None:
    mcp.tool()(align_status_tool)
    mcp.tool()(align_brief_tool)
    mcp.tool()(align_done_tool)
    mcp.tool()(align_waive_tool)
