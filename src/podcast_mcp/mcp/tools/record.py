from __future__ import annotations

import json

from mcp.server import MCPServer

from podcast_mcp.services.record.control import RecordControlService
from podcast_mcp.services.workspace import ProjectWorkspace


def _ctrl(project_path: str) -> RecordControlService:
    """Open a RecordControlService for the project (internal helper, not an MCP tool)."""
    return RecordControlService(ProjectWorkspace.open(project_path))


def record_state_tool(project_path: str) -> str:
    """Read the live recording-room snapshot (roster, take clock, consent)."""
    try:
        snap = _ctrl(project_path).snapshot()
    except FileNotFoundError:
        return json.dumps({"available": False, "hint": "Mint a record room first."}, indent=2)
    return json.dumps({"available": True, **snap}, indent=2)


def record_start_tool(project_path: str) -> str:
    """Host Start for the current record room (blocked until guests consent)."""
    return json.dumps(_ctrl(project_path).start(), indent=2)


def record_pause_tool(project_path: str) -> str:
    """Host Pause for the current take."""
    return json.dumps(_ctrl(project_path).pause(), indent=2)


def record_resume_tool(project_path: str) -> str:
    """Host Resume for a paused take."""
    return json.dumps(_ctrl(project_path).resume(), indent=2)


def record_stop_tool(project_path: str) -> str:
    """Host Stop for the current take."""
    return json.dumps(_ctrl(project_path).stop(), indent=2)


def record_land_tool(project_path: str) -> str:
    """Copy ACK'd keepers into raw/ and land live comments on the timeline."""
    return json.dumps(_ctrl(project_path).land(), indent=2)


def record_discard_take_tool(project_path: str, take_index: int) -> str:
    """Delete a terminal take (refused while its upload manifest is in flight)."""
    return json.dumps(_ctrl(project_path).discard_take(take_index), indent=2)


def register(mcp: MCPServer) -> None:
    """Register recording-room tools on the MCP server."""
    mcp.tool()(record_state_tool)
    mcp.tool()(record_start_tool)
    mcp.tool()(record_pause_tool)
    mcp.tool()(record_resume_tool)
    mcp.tool()(record_stop_tool)
    mcp.tool()(record_land_tool)
    mcp.tool()(record_discard_take_tool)
