from __future__ import annotations

import json

from mcp.server import MCPServer

from podcast_mcp.services.session_control import SessionControlService
from podcast_mcp.services.workspace import ProjectWorkspace


def _parse_selection(selection_json: str | None) -> dict | None:
    """Parse an optional JSON selection object (internal helper, not an MCP tool)."""
    if selection_json is None or selection_json == "":
        return None
    data = json.loads(selection_json)
    if data is None:
        return None
    if not isinstance(data, dict):
        raise ValueError("selection_json must be a JSON object or null")
    return data


def get_session_state_tool(project_path: str) -> str:
    """Read shared DAW/agent session state (playhead, region, mode, selection)."""
    ws = ProjectWorkspace.open(project_path)
    state = SessionControlService(ws).get_state()
    if state is None:
        return json.dumps(
            {
                "available": False,
                "hint": "Call open_gui_tool (or podcast gui --background) or play/seek to create session state",
            },
            indent=2,
        )
    return json.dumps({"available": True, **state}, indent=2)


def get_session_presence_tool(project_path: str) -> str:
    """Who is in the Sharecut Studio session: display names, cursor, selection, viewport, transport, follow relationships.

    `viewport` is the time window a follower should show. Near the start of a
    phone's fixed-playhead timeline it begins at 0 and can be wider than what
    is on that screen.
    """
    ws = ProjectWorkspace.open(project_path)
    roster = SessionControlService(ws).presence()
    if not roster:
        return json.dumps(
            {
                "available": True,
                "clients": [],
                "hint": "No live clients. Open Sharecut Studio or wait for a guest to join.",
            },
            indent=2,
        )
    return json.dumps({"available": True, "clients": roster}, indent=2)


def seek_session_tool(
    project_path: str,
    playhead_sec: float,
    selection_json: str | None = None,
) -> str:
    """Seek the open DAW playhead (no OS audio). Optional selection_json highlights a modifier."""
    ws = ProjectWorkspace.open(project_path)
    state = SessionControlService(ws).seek(
        playhead_sec,
        selection=_parse_selection(selection_json),
    )
    return json.dumps(state, indent=2)


def set_session_selection_tool(
    project_path: str,
    selection_json: str | None = None,
) -> str:
    """Highlight a DAW modifier: {kind, id?, track_id?, time?} or null to clear."""
    ws = ProjectWorkspace.open(project_path)
    state = SessionControlService(ws).set_selection(_parse_selection(selection_json))
    return json.dumps(state, indent=2)


def set_session_playing_tool(project_path: str, playing: bool) -> str:
    """Start or pause DAW browser transport (no OS audio)."""
    ws = ProjectWorkspace.open(project_path)
    state = SessionControlService(ws).set_playing(playing)
    return json.dumps(state, indent=2)


def stop_session_tool(project_path: str) -> str:
    """Pause DAW transport and clear the highlight region."""
    ws = ProjectWorkspace.open(project_path)
    state = SessionControlService(ws).stop()
    return json.dumps(state, indent=2)


def set_session_mode_tool(project_path: str, mode: str) -> str:
    """Set DAW audition mode: mix | fx | raw."""
    ws = ProjectWorkspace.open(project_path)
    state = SessionControlService(ws).set_mode(mode)
    return json.dumps(state, indent=2)


def set_session_region_tool(
    project_path: str,
    start_sec: float,
    end_sec: float,
    playing: bool = False,
    query: str | None = None,
    selection_json: str | None = None,
) -> str:
    """Highlight a timeline region in the DAW; optionally start browser playback."""
    ws = ProjectWorkspace.open(project_path)
    state = SessionControlService(ws).set_region(
        start_sec,
        end_sec,
        playing=playing,
        query=query,
        selection=_parse_selection(selection_json),
    )
    return json.dumps(state, indent=2)


def register(mcp: MCPServer) -> None:
    """Register session control tools on the MCP server."""
    mcp.tool()(get_session_state_tool)
    mcp.tool()(get_session_presence_tool)
    mcp.tool()(seek_session_tool)
    mcp.tool()(set_session_selection_tool)
    mcp.tool()(set_session_playing_tool)
    mcp.tool()(stop_session_tool)
    mcp.tool()(set_session_mode_tool)
    mcp.tool()(set_session_region_tool)
