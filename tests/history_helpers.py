"""Helpers for document-plane history moves (#1031).

``UndoHistory`` / ``RedoHistory`` require the head the caller saw. A test that plays a
client which is up to date sends the head the project holds now.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import HistoryService


def seen_head(project_path: Path) -> str:
    """The history head an up-to-date client sees (``history.head_id``)."""
    return HistoryService(ProjectWorkspace.open(project_path)).status()["head_id"]


def history_move(project_path: Path, **extra: Any) -> dict[str, Any]:
    """An ``UndoHistory`` / ``RedoHistory`` payload from a client that saw the latest head."""
    return {"expected_head_id": seen_head(project_path), **extra}
