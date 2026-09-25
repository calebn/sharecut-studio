from __future__ import annotations

from mcp.server import MCPServer

from podcast_mcp.mcp.tools.agent_notify import notify_after_mutation
from podcast_mcp.services import EpisodeService, ProjectWorkspace


def episode_create(workspace_dir: str, name: str = "episode") -> str:
    """Create a new episode project in a workspace directory and return its path."""
    ws = ProjectWorkspace.create(workspace_dir, name=name)
    return str(ws.path)


def track_add(
    project_path: str,
    track_id: str,
    file_path: str,
    role: str = "dialogue",
    speaker: str | None = None,
    label: str | None = None,
) -> str:
    """Add an audio track to the project from a media file."""
    ws = ProjectWorkspace.open(project_path)
    return EpisodeService(ws).add_track(
        track_id, file_path, role=role, speaker=speaker, label=label
    )


def track_add_empty_tool(
    project_path: str,
    track_id: str,
    role: str = "dialogue",
    speaker: str | None = None,
    label: str | None = None,
) -> dict:
    """Add an empty (silent placeholder) track to the project."""
    ws = ProjectWorkspace.open(project_path)
    return EpisodeService(ws).add_empty_track(track_id, role=role, speaker=speaker, label=label)


def track_set_media_tool(project_path: str, track_id: str, file_path: str) -> dict:
    """Replace the media file backing an existing track."""
    ws = ProjectWorkspace.open(project_path)
    return EpisodeService(ws).set_track_media(track_id, file_path)


def track_set_meta_tool(
    project_path: str,
    track_id: str,
    label: str | None = None,
    role: str | None = None,
    speaker: str | None = None,
) -> dict:
    """Update a track's label, role, or speaker metadata."""
    ws = ProjectWorkspace.open(project_path)
    return EpisodeService(ws).set_track_meta(track_id, label=label, role=role, speaker=speaker)


def track_set_volume_tool(project_path: str, track_id: str, fader_db: float) -> dict:
    """Set a track's saved volume in dB (-60 to +12), on top of its staging gain.

    The mix plays the track at ``gain_db + fader_db``; the pipeline's balance
    step never changes the fader. Undoable; stales the premix until re-mixed.
    """
    ws = ProjectWorkspace.open(project_path)
    return EpisodeService(ws).set_track_volume(track_id, fader_db)


def track_set_mute_tool(project_path: str, track_id: str, muted: bool) -> dict:
    """Mute or unmute a track in the saved mix.

    Play and bounce leave a muted track out at once, and the premix after the
    next re-mix (Refresh). The track stays on the timeline: edits and analysis
    still cover it. Undoable. Solo is a per-listener GUI control, not saved.
    """
    ws = ProjectWorkspace.open(project_path)
    return EpisodeService(ws).set_track_mute(track_id, muted)


def track_remove_tool(project_path: str, track_id: str) -> dict:
    """Remove a track from the project."""
    ws = ProjectWorkspace.open(project_path)
    return EpisodeService(ws).remove_track(track_id)


def track_reorder_tool(project_path: str, track_id: str, index: int) -> dict:
    """Move a track to a new position in the track order."""
    ws = ProjectWorkspace.open(project_path)
    return EpisodeService(ws).reorder_track(track_id, index)


def register(mcp: MCPServer) -> None:
    """Register episode and track tools on the MCP server."""
    mcp.tool()(episode_create)
    mutating = {
        track_add,
        track_add_empty_tool,
        track_set_media_tool,
        track_set_meta_tool,
        track_set_volume_tool,
        track_set_mute_tool,
        track_remove_tool,
        track_reorder_tool,
    }
    for fn in (
        track_add,
        track_add_empty_tool,
        track_set_media_tool,
        track_set_meta_tool,
        track_set_volume_tool,
        track_set_mute_tool,
        track_remove_tool,
        track_reorder_tool,
    ):
        mcp.tool()(notify_after_mutation(fn) if fn in mutating else fn)
