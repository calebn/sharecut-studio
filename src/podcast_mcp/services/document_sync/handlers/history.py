"""Document-plane history command handlers."""

from __future__ import annotations

from typing import Any

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService


def _host_only_fields(ws: ProjectWorkspace) -> set[str]:
    """``guest_step`` tells the host a guest's step moved; a guest's own reply never carries it."""
    return {"guest_step"} if ws.share_author is not None else set()


def undo_history(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return (
        HistoryService(ws)
        .undo(rerender=bool(p.get("rerender", False)), expected_head_id=str(p["expected_head_id"]))
        .model_dump(exclude=_host_only_fields(ws))
    )


def redo_history(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return (
        HistoryService(ws)
        .redo(rerender=bool(p.get("rerender", False)), expected_head_id=str(p["expected_head_id"]))
        .model_dump(exclude=_host_only_fields(ws))
    )
