"""Mint preflight: does the current room hold a stopped take that is not saved to the episode?"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.session_suggestions import session_suggestion_for
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.record.landing import STAGED_TARGET_KINDS
from podcast_mcp.services.record.service import RecordSessionService, _store_for
from podcast_mcp.services.record.state import RecordSnapshot
from podcast_mcp.services.record.upload import RecordUploadService


@dataclass(frozen=True)
class Unsaved:
    """Stopped takes of the active room whose recordings are not on the episode.

    ``takes`` counts every such take. ``saving`` is how many of them still have a recording
    uploading (no finished file yet). ``closed`` is true when landing would refuse them: the
    room's staged session was already accepted or skipped, so later takes have nowhere to go.
    """

    takes: int = 0
    saving: int = 0
    closed: bool = False


def unsaved_takes(project: EpisodeProject) -> Unsaved:
    """Count the active room's stopped, not-discarded takes with an unlanded recording.

    Discarded takes are not counted (the upload status drops them).
    """
    session_id = RecordSessionService.active_session_id(project)
    raw = _store_for(project).get_snapshot() if session_id else None
    if not session_id or not raw:
        return Unsaved()
    snap = RecordSnapshot.model_validate(raw)
    stopped = {t.take_index for t in snap.takes if t.stopped_wall_ms is not None}
    segments = RecordUploadService(project).status(session_id=session_id)["segments"]
    pending = [
        row for row in segments if not row.get("landed") and int(row["take_index"]) in stopped
    ]
    if not pending:
        return Unsaved()
    held = (
        session_suggestion_for(project, session_id)
        if snap.target.kind in STAGED_TARGET_KINDS
        else None
    )
    return Unsaved(
        takes=len({int(row["take_index"]) for row in pending}),
        saving=len({int(row["take_index"]) for row in pending if not row.get("file_ack")}),
        closed=held is not None and held.status != "pending",
    )


def unsaved_fields(unsaved: Unsaved) -> dict[str, Any]:
    return {
        "unlanded_take": unsaved.takes > 0,
        "unlanded_takes": unsaved.takes,
        "unlanded_saving": unsaved.saving,
    }


def with_unsaved_takes(project: EpisodeProject, snapshot: dict[str, Any]) -> dict[str, Any]:
    """The host record snapshot plus the mint preflight fields."""
    return {**snapshot, **unsaved_fields(unsaved_takes(project))}


def _takes(count: int) -> str:
    return "1 stopped take" if count == 1 else f"{count} stopped takes"


def describe_unsaved_takes(unsaved: Unsaved) -> str:
    """One plain sentence for CLI, MCP and HTTP callers; the same words everywhere."""
    it = "it" if unsaved.takes == 1 else "them"
    text = (
        f"{_takes(unsaved.takes)} in this room "
        f"{'is' if unsaved.takes == 1 else 'are'} not saved to the episode yet, "
        f"and a new room leaves {it} behind."
    )
    if unsaved.saving:
        text += f" {_takes(unsaved.saving)} still saving."
    if unsaved.closed:
        text += " This room's session was already accepted or skipped, so they cannot be saved."
    return text + " Save before starting a new room, or start anyway."


def refuse_land_first(unsaved: Unsaved, *, after_land: bool) -> str | None:
    """Why land-first cannot go ahead (None when it can)."""
    if not unsaved.takes:
        return None
    if unsaved.saving:
        return (
            f"{_takes(unsaved.saving)} still saving. Try again in a moment; "
            "no new room was started."
        )
    if unsaved.closed:
        return (
            "This room's session was already accepted or skipped, so its newer takes "
            "cannot be saved. No new room was started; start anyway to leave them behind."
        )
    if after_land:
        return (
            f"{_takes(unsaved.takes)} could not be saved. No new room was started; "
            "land the room and read what it says, or start anyway."
        )
    return None
