from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field


class HistoryEntry(BaseModel):
    id: str
    label: str
    created_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    snapshot_file: str
    operation: str | None = None
    params: dict[str, Any] | None = None


class ProjectHistory(BaseModel):
    """Undo/redo stack; cursor points at the active snapshot entry."""

    cursor: int = -1
    entries: list[HistoryEntry] = Field(default_factory=list)

    def can_undo(self) -> bool:
        return self.cursor > 0

    def can_redo(self) -> bool:
        return self.cursor >= 0 and self.cursor < len(self.entries) - 1


class ProjectStateSnapshot(BaseModel):
    """Editable v2 project layers restored by undo/redo."""

    sources: list[Any] = Field(default_factory=list)
    timeline: dict[str, Any] = Field(default_factory=dict)
    editorial: dict[str, Any] = Field(default_factory=dict)
    transcripts: dict[str, Any] = Field(default_factory=dict)
    mix: dict[str, Any] = Field(default_factory=dict)
    social: dict[str, Any] = Field(default_factory=dict)
    review: dict[str, Any] = Field(default_factory=dict)
    render_last_completed_step: str | None = None
    meta: dict[str, Any] | None = None
