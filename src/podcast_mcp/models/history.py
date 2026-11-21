from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, NamedTuple

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
    author: str | None = None
    undone_by: str | None = None


class StepOwners(NamedTuple):
    """Who may take back (``undo``) and bring back (``redo``) the next step, as stored."""

    undo: str | None
    redo: str | None


class HistoryNavigation(NamedTuple):
    undo_origin: int | None
    redo_index: int | None
    redo_owner_index: int | None


class ProjectHistory(BaseModel):
    """Undo/redo stack; cursor points at the active snapshot entry."""

    cursor: int = -1
    entries: list[HistoryEntry] = Field(default_factory=list)

    def is_empty(self) -> bool:
        """True before any snapshot has been recorded (no entries, no cursor)."""
        return not self.entries and self.cursor < 0

    def navigation(self, skip: Callable[[int], bool] | None = None) -> HistoryNavigation:
        """Find the next edit in each direction, optionally skipping verified legacy rows.

        Undo steps back from the edit that caused an automatic preview (#1675). Redo
        can land on a preview before reaching the edit that governs guest ownership.
        """
        if not 0 <= self.cursor < len(self.entries):
            return HistoryNavigation(None, None, None)

        origin = self.cursor
        while origin > 0:
            if self.entries[origin].operation != "render_preview" and not (skip and skip(origin)):
                break
            origin -= 1

        redo_index = None
        redo_owner = None
        for index in range(self.cursor + 1, len(self.entries)):
            if skip and skip(index):
                continue
            if redo_index is None:
                redo_index = index
            if self.entries[index].operation != "render_preview":
                redo_owner = index
                break
        return HistoryNavigation(origin if origin > 0 else None, redo_index, redo_owner)

    def can_undo(self) -> bool:
        return self.navigation().undo_origin is not None

    def can_redo(self) -> bool:
        return self.navigation().redo_index is not None

    def step_owners(self, navigation: HistoryNavigation | None = None) -> StepOwners:
        """The author of the step Undo takes back and the one who undid the step Redo brings
        back. A guest may move a step only when it is theirs; ``None`` is never a guest's."""
        origin, _, redo_owner = navigation or self.navigation()
        undo = self.entries[origin] if origin is not None else None
        redo = self.entries[redo_owner] if redo_owner is not None else None
        return StepOwners(undo.author if undo else None, redo.undone_by if redo else None)

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
    feed: dict[str, Any] = Field(default_factory=dict)
    review: dict[str, Any] = Field(default_factory=dict)
    render_last_completed_step: str | None = None
    meta: dict[str, Any] | None = None
