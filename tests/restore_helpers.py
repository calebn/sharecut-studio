"""Shared assertions for Restore results."""

from __future__ import annotations

HISTORY_ONLY_MESSAGE = (
    "This edit cannot be restored individually. Use History Undo to restore the whole action. "
    "History Undo also undoes the other edits in that action. "
    "You may need to undo later actions first."
)


def assert_history_only_conflict(result, record_id: str) -> None:
    """A history-only record comes back as RestoreResult conflict data, never an exception."""
    assert result["status"] == "conflict"
    assert result["conflicts"] == [
        {
            "code": "local_restore_requires_history",
            "record_id": record_id,
            "message": HISTORY_ONLY_MESSAGE,
            "track_id": None,
            "blocked_by": [],
        }
    ]
