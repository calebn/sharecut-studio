"""Mint preflight: does the current room hold a stopped take that is not saved to the episode?"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.session_suggestions import session_suggestion_for
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.record.landing import STAGED_TARGET_KINDS
from podcast_mcp.services.record.service import RecordSessionService, _store_for
from podcast_mcp.services.record.state import RecordSnapshot, TakeState
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


def _expected_segments(take: TakeState) -> int:
    """Segments each recorded person uploads for a take: one, plus one per Resume."""
    return 1 + sum(1 for entry in take.pauses if entry.resume_wall_ms is not None)


def _missing_uploads(snap: RecordSnapshot, rows: list[dict[str, Any]], skip: set[int]) -> set[int]:
    """Stopped takes where a consented guest has nothing uploaded yet for a segment.

    Between Stop and a device's first chunk there is no upload row at all, so rows alone
    cannot see that take; the roster the take captured at Start says who should upload.
    """
    have = {(int(r["take_index"]), str(r["participant_id"]), int(r["segment_index"])) for r in rows}
    # The host is left out: a host whose mic was denied never uploads, and says so on Stop.
    guests = {p.participant_id for p in snap.participants if p.role == "guest"}
    gone = {p.participant_id for p in snap.participants if p.removed}
    missing: set[int] = set()
    for take in snap.takes:
        if take.stopped_wall_ms is None or take.take_index in skip:
            continue
        for pid in take.consented_participant_ids:
            if pid not in guests or pid in gone:
                continue
            for segment in range(_expected_segments(take)):
                if (take.take_index, pid, segment) not in have:
                    missing.add(take.take_index)
    return missing


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
    uploads = RecordUploadService(project)
    segments = uploads.status(session_id=session_id)["segments"]
    pending = [
        row for row in segments if not row.get("landed") and int(row["take_index"]) in stopped
    ]
    not_started = _missing_uploads(snap, segments, uploads.tombstoned_takes(session_id))
    if not pending and not not_started:
        return Unsaved()
    held = (
        session_suggestion_for(project, session_id)
        if snap.target.kind in STAGED_TARGET_KINDS
        else None
    )
    return Unsaved(
        takes=len({int(row["take_index"]) for row in pending} | not_started),
        saving=len(
            {int(row["take_index"]) for row in pending if not row.get("file_ack")} | not_started
        ),
        closed=held is not None and held.status != "pending",
    )


def unsaved_fields(unsaved: Unsaved) -> dict[str, Any]:
    return {
        "unlanded_take": unsaved.takes > 0,
        "unlanded_takes": unsaved.takes,
        "unlanded_saving": unsaved.saving,
        "land_first_possible": land_first_would_work(unsaved),
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
    if land_first_would_work(unsaved):
        return text + " Save before starting a new room, or start anyway."
    return text + " Start anyway to leave them behind."


def refuse_land_first(unsaved: Unsaved, *, after_land: bool) -> str | None:
    """Why land-first cannot go ahead (None when it can)."""
    if not unsaved.takes:
        return None
    if unsaved.saving:
        return (
            f"{_takes(unsaved.saving)} still saving. Try again in a moment, or start anyway. "
            "If a device never finishes, run a manual land to keep what has saved. "
            "No new room was started."
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


def land_first_would_work(unsaved: Unsaved) -> bool:
    """Whether land-first has a chance: something to save, nothing saving, session still open."""
    return unsaved.takes > 0 and not unsaved.saving and not unsaved.closed
