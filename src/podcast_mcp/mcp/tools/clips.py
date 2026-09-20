from __future__ import annotations

import json

from mcp.server import MCPServer

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.mcp.tools.agent_notify import notify_after_mutation
from podcast_mcp.services import ClipService, ProjectWorkspace


def propose_social_clips_tool(
    project_path: str,
    platform: str | None = None,
    max_clips: int | None = None,
) -> str:
    """Propose short-form social clips for a platform, limited to max_clips."""
    ws = ProjectWorkspace.open(project_path)
    clips = ClipService(ws).propose(platform=platform, max_clips=max_clips)
    return to_json([c.model_dump() for c in clips])


def list_social_clips_tool(
    project_path: str,
    approved: bool | None = None,
) -> str:
    """List proposed social clips, optionally filtered by approved status."""
    ws = ProjectWorkspace.open(project_path)
    clips = ClipService(ws).list(approved=approved)
    return to_json([c.model_dump() for c in clips])


def approve_social_clips_tool(project_path: str, ids_json: str) -> str:
    """Approve social clips by id from a JSON id array."""
    ws = ProjectWorkspace.open(project_path)
    ids = json.loads(ids_json)
    ClipService(ws).approve(ids)
    return f"Approved {len(ids)} clip(s)"


def reject_social_clips_tool(project_path: str, ids_json: str) -> str:
    """Reject social clips by id from a JSON id array."""
    ws = ProjectWorkspace.open(project_path)
    ids = json.loads(ids_json)
    ClipService(ws).reject(ids)
    return f"Rejected {len(ids)} clip(s)"


def social_clip_report_tool(project_path: str) -> str:
    """Return the social clip pipeline report (proposed, approved, exported counts)."""
    ws = ProjectWorkspace.open(project_path)
    return ClipService(ws).report()


def export_social_clips_tool(project_path: str, ids_json: str | None = None) -> str:
    """Export social clips to files; omit ids_json to export all approved."""
    ws = ProjectWorkspace.open(project_path)
    ids = json.loads(ids_json) if ids_json else None
    exported = ClipService(ws).export(ids)
    return to_json(exported)


def register(mcp: MCPServer) -> None:
    """Register social clip tools on the MCP server."""
    mutating = {
        propose_social_clips_tool,
        approve_social_clips_tool,
        reject_social_clips_tool,
        export_social_clips_tool,
    }
    for fn in (
        propose_social_clips_tool,
        list_social_clips_tool,
        approve_social_clips_tool,
        reject_social_clips_tool,
        social_clip_report_tool,
        export_social_clips_tool,
    ):
        mcp.tool()(notify_after_mutation(fn) if fn in mutating else fn)
