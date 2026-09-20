"""Document-plane history command handlers."""

from __future__ import annotations

from typing import Any

from podcast_mcp.services.history import HistoryService
from podcast_mcp.services.workspace import ProjectWorkspace


def undo_history(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return HistoryService(ws).undo(rerender=bool(p.get("rerender", False)))


def redo_history(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return HistoryService(ws).redo(rerender=bool(p.get("rerender", False)))
