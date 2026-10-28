from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field

HISTORY_ROOT_ID = "root"
"""The head of a history that holds no entry yet. Entry ids are 12 hex characters, so it
never names an entry; a caller that saw an empty history sends it, and the guard refuses
once any entry exists instead of treating "no head" as "do not check"."""


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

    def is_empty(self) -> bool:
        """True before any snapshot has been recorded (no entries, no cursor)."""
        return not self.entries and self.cursor < 0

    def undo_origin(self) -> int:
        """The cursor an Undo steps back from, skipping automatic ``render_preview`` entries.

        Auto refresh-mix lands after the edit that caused it, so Undo on the preview head
        reverts that edit in one step. A preview below the tip is skipped too, so Undo of
        the second of two edits does not stop on the first edit's preview (#1675)."""
        i = self.cursor
        while 0 < i < len(self.entries) and self.entries[i].operation == "render_preview":
            i -= 1
        return i

    def can_undo(self) -> bool:
        return self.undo_origin() > 0

    def can_redo(self) -> bool:
        return self.cursor >= 0 and self.cursor < len(self.entries) - 1

    def edit_head_id(self) -> str:
        """Id of the latest entry at or below the cursor that is not an automatic
        ``render_preview``, or ``head_id()`` when there is none.

        A mix rebuild adds a preview entry after an edit without changing what the project
        holds, so something that depends on the edits compares this, not ``head_id()``.
        """
        for i in range(min(self.cursor, len(self.entries) - 1), -1, -1):
            if self.entries[i].operation != "render_preview":
                return self.entries[i].id
        return self.head_id()

    def head_id(self) -> str:
        """Id of the entry the project currently holds (the cursor's), or ``HISTORY_ROOT_ID``
        before any.

        Unlike ``cursor``, it names one entry for good: pruning at the entry limit keeps the
        cursor at the same index while the entry there changes.
        """
        if 0 <= self.cursor < len(self.entries):
            return self.entries[self.cursor].id
        return HISTORY_ROOT_ID


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
