from __future__ import annotations

from mcp.server import MCPServer

from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.mcp.tools.agent_notify import notify_after_mutation
from podcast_mcp.services import HistoryService, ProjectWorkspace


def history_undo(project_path: str, rerender: bool = False) -> str:
    """Undo the last project mutation (timeline, transcript, or settings)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(HistoryService(ws).undo(rerender=rerender))


def history_redo(project_path: str, rerender: bool = False) -> str:
    """Redo the last undone project mutation."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(HistoryService(ws).redo(rerender=rerender))


def history_list(project_path: str) -> str:
    """List the project's history entries (index, label, mutation type)."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(HistoryService(ws).list_entries())


def history_status_tool(project_path: str) -> str:
    """Report history cursor, total, undo/redo availability, and current label."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(HistoryService(ws).status())


def history_goto_tool(project_path: str, index: int, rerender: bool = False) -> str:
    """Jump the project state to a history index."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(HistoryService(ws).goto(index, rerender=rerender))


def history_diff_tool(
    project_path: str,
    from_index: int | None = None,
    to_index: int | None = None,
) -> str:
    """Diff two history indices, showing what changed between them."""
    ws = ProjectWorkspace.open(project_path)
    return to_json(HistoryService(ws).diff(from_index=from_index, to_index=to_index))


def history_record(project_path: str, label: str = "manual") -> str:
    """Record a named history checkpoint for the current project state."""
    ws = ProjectWorkspace.open(project_path)
    return to_json({"id_label": HistoryService(ws).record(label)})


def register(mcp: MCPServer) -> None:
    """Register history tools on the MCP server."""
    mutating = {
        history_undo,
        history_redo,
        history_goto_tool,
        history_record,
    }
    for fn in (
        history_undo,
        history_redo,
        history_list,
        history_status_tool,
        history_goto_tool,
        history_diff_tool,
        history_record,
    ):
        mcp.tool()(notify_after_mutation(fn) if fn in mutating else fn)
