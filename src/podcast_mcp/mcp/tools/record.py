from __future__ import annotations

import json

from mcp.server import MCPServer

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.record import RecordControlService


def _ctrl(project_path: str) -> RecordControlService:
    """Open a RecordControlService for the project (internal helper, not an MCP tool)."""
    return RecordControlService(ProjectWorkspace.open(project_path))


def record_state_tool(project_path: str) -> str:
    """Read the live recording-room snapshot (roster, take clock, consent, and the mint preflight: unlanded_take / unlanded_takes = stopped takes not yet saved to the episode, unlanded_saving = how many of those are still uploading or not started, unlanded_stalled = recordings that never finished uploading, land_first_possible = a prediction: true when a land could save a finished recording and nothing is saving)."""
    try:
        snap = _ctrl(project_path).snapshot()
    except FileNotFoundError:
        return json.dumps({"available": False, "hint": "Mint a record room first."}, indent=2)
    return json.dumps({"available": True, **snap}, indent=2)


def record_start_tool(project_path: str) -> str:
    """Host Start for the current record room (a solo take works; blocked while a joined guest has not consented)."""
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


def record_room_tone_tool(project_path: str) -> str:
    """Host Room tone: tell every recorded device to capture 3 s of room tone now (lobby or stopped only)."""
    return json.dumps(_ctrl(project_path).room_tone_countdown(), indent=2)


def record_target_tool(project_path: str, target: str = "end") -> str:
    """Host Target: set where this room's session lands (``end``, ``start``, or an ``insert``/``replace`` JSON object that stages the session as a suggestion; refused once a take exists)."""
    return json.dumps(_ctrl(project_path).set_target(target), indent=2)


def record_marker_tool(project_path: str, body: str = "Marker") -> str:
    """Host Marker: stamp the open take now; record_land_tool lands it as a comment."""
    return json.dumps(_ctrl(project_path).marker(body), indent=2)


def record_land_tool(project_path: str) -> str:
    """Land saved full-quality recordings and live comments on the timeline."""
    return json.dumps(_ctrl(project_path).land(), indent=2)


def record_discard_take_tool(project_path: str, take_index: int) -> str:
    """Delete a terminal take (refused while its full-quality recordings are still saving to the project)."""
    return json.dumps(_ctrl(project_path).discard_take(take_index), indent=2)


def record_tracks_tool(project_path: str) -> str:
    """Show which track each recorded person lands on (matched by name to an existing track, new, or ambiguous, which also covers a track already used by someone else: reason track_in_use), with a plain-words reason. Host only."""
    return json.dumps(_ctrl(project_path).tracks(), indent=2)


def record_assign_track_tool(project_path: str, participant_id: str, track: str) -> str:
    """Correct a person's track: put their recordings on an existing track id, or pass track="new" for a new one. Allowed until the session is accepted; one undo step when takes are already staged. Refusal codes: unknown_participant, unknown_track, track_taken, replace_target_track, person_removed, session_already_accepted, session_skipped."""
    return json.dumps(_ctrl(project_path).assign_track(participant_id, track), indent=2)


def register(mcp: MCPServer) -> None:
    """Register recording-room tools on the MCP server."""
    mcp.tool()(record_state_tool)
    mcp.tool()(record_start_tool)
    mcp.tool()(record_pause_tool)
    mcp.tool()(record_resume_tool)
    mcp.tool()(record_stop_tool)
    mcp.tool()(record_room_tone_tool)
    mcp.tool()(record_target_tool)
    mcp.tool()(record_marker_tool)
    mcp.tool()(record_land_tool)
    mcp.tool()(record_discard_take_tool)
    mcp.tool()(record_tracks_tool)
    mcp.tool()(record_assign_track_tool)
