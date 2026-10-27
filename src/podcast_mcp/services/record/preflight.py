"""Mint preflight: does the current room hold a stopped take that is not saved to the episode?"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from podcast_mcp.edits.session_suggestions import session_suggestion_for
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.record.landing import STAGED_TARGET_KINDS
from podcast_mcp.services.record.service import RecordSessionService, _store_for
from podcast_mcp.services.record.state import RecordSnapshot
from podcast_mcp.services.record.upload import RecordUploadService

#: How long after Stop (or after a guest's last chunk) an upload still counts as "saving".
#: Later than this it is "never finished": reported, but it no longer blocks land-first.
UPLOAD_GRACE_MS = 10 * 60 * 1000


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(frozen=True)
class Unsaved:
    """Stopped takes of the active room whose recordings are not on the episode.

    ``takes``: every take with something unsaved. ``landable``: takes with a finished
    recording a land can save. ``saving``: takes with a guest upload still within the grace
    window. ``stalled``: guest recordings that never finished (a partial upload gone quiet,
    a removed guest's partial upload, or nothing arriving after the grace window); a land
    cannot save them. ``closed``: the room's staged session was already accepted or skipped,
    so landing refuses its newer takes.
    """

    takes: int = 0
    landable: int = 0
    saving: int = 0
    stalled: int = 0
    closed: bool = False


def unsaved_takes(project: EpisodeProject, *, now_wall_ms: int | None = None) -> Unsaved:
    """Count the active room's stopped, not-discarded takes with a recording not on the episode."""
    now = _now_ms() if now_wall_ms is None else now_wall_ms
    session_id = RecordSessionService.active_session_id(project)
    raw = _store_for(project).get_snapshot() if session_id else None
    if not session_id or not raw:
        return Unsaved()
    snap = RecordSnapshot.model_validate(raw)
    uploads = RecordUploadService(project)
    rows = uploads.status(session_id=session_id)["segments"]
    tombstoned = uploads.tombstoned_takes(session_id)
    by_pid = {p.participant_id: p for p in snap.participants}
    landable: set[int] = set()
    saving: set[int] = set()
    stalled: set[tuple[int, str]] = set()
    seen = {(int(r["take_index"]), str(r["participant_id"])) for r in rows}
    for take in snap.takes:
        if take.stopped_wall_ms is None or take.take_index in tombstoned:
            continue
        index = take.take_index
        for row in rows:
            if int(row["take_index"]) != index or row.get("landed"):
                continue
            pid = str(row["participant_id"])
            if row.get("file_ack"):
                landable.add(index)
                continue
            person = by_pid.get(pid)
            last = uploads.segment_last_activity_ms(
                session_id, index, pid, int(row["segment_index"])
            )
            quiet = now - (last if last is not None else take.stopped_wall_ms)
            if (person is not None and person.removed) or quiet > UPLOAD_GRACE_MS:
                stalled.add((index, pid))
            else:
                saving.add(index)
        # A consenting guest with no upload at all yet: expected within the grace window only.
        # The host is not expected (a host whose mic was denied never uploads).
        for pid in take.consented_participant_ids:
            person = by_pid.get(pid)
            if person is None or person.role != "guest" or person.removed:
                continue
            if (index, pid) in seen:
                continue
            if now - take.stopped_wall_ms > UPLOAD_GRACE_MS:
                stalled.add((index, pid))
            else:
                saving.add(index)
    all_takes = landable | saving | {index for index, _pid in stalled}
    if not all_takes:
        return Unsaved()
    held = (
        session_suggestion_for(project, session_id)
        if snap.target.kind in STAGED_TARGET_KINDS
        else None
    )
    return Unsaved(
        takes=len(all_takes),
        landable=len(landable),
        saving=len(saving),
        stalled=len(stalled),
        closed=held is not None and held.status != "pending",
    )


def land_first_would_work(unsaved: Unsaved) -> bool:
    """True when a land can save something now: a finished recording, nothing still saving."""
    return unsaved.landable > 0 and not unsaved.saving and not unsaved.closed


def unsaved_fields(unsaved: Unsaved) -> dict[str, Any]:
    return {
        "unlanded_take": unsaved.takes > 0,
        "unlanded_takes": unsaved.takes,
        "unlanded_saving": unsaved.saving,
        "unlanded_stalled": unsaved.stalled,
        "land_first_possible": land_first_would_work(unsaved),
    }


def with_unsaved_takes(project: EpisodeProject, snapshot: dict[str, Any]) -> dict[str, Any]:
    """The host record snapshot plus the mint preflight fields."""
    return {**snapshot, **unsaved_fields(unsaved_takes(project))}


def _takes(count: int) -> str:
    return "1 stopped take" if count == 1 else f"{count} stopped takes"


def _recordings(count: int) -> str:
    return "1 guest recording" if count == 1 else f"{count} guest recordings"


def describe_unsaved_takes(unsaved: Unsaved) -> str:
    """Plain sentences for CLI, MCP and HTTP callers; the same words everywhere."""
    parts: list[str] = []
    if unsaved.landable:
        it = "it" if unsaved.landable == 1 else "them"
        parts.append(
            f"{_takes(unsaved.landable)} in this room "
            f"{'is' if unsaved.landable == 1 else 'are'} not saved to the episode yet, "
            f"and a new room leaves {it} behind."
        )
    if unsaved.saving:
        parts.append(f"{_takes(unsaved.saving)} still saving.")
    if unsaved.stalled:
        parts.append(
            f"{_recordings(unsaved.stalled)} never finished uploading and cannot be saved."
        )
    if unsaved.closed:
        parts.append(
            "This room's session was already accepted or skipped, so its newer takes "
            "cannot be saved."
        )
    if land_first_would_work(unsaved):
        parts.append("Save before starting a new room, or start anyway.")
    elif unsaved.landable or unsaved.saving:
        parts.append("Start anyway to leave them behind.")
    return " ".join(parts)


def refuse_land_first(unsaved: Unsaved, *, after_land: bool) -> str | None:
    """Why land-first cannot go ahead (None when it can)."""
    if not (unsaved.landable or unsaved.saving):
        return None
    if unsaved.saving:
        return (
            f"{_takes(unsaved.saving)} still saving. Try again in a moment, or start anyway. "
            "No new room was started."
        )
    if unsaved.closed:
        return (
            "This room's session was already accepted or skipped, so its newer takes "
            "cannot be saved. No new room was started; start anyway to leave them behind."
        )
    if after_land:
        return (
            f"{_takes(unsaved.landable)} could not be saved. No new room was started; "
            "land the room and read what it says, or start anyway."
        )
    return None


def left_behind_message(unsaved: Unsaved) -> str | None:
    """What a mint left behind that no land could have saved (None when nothing)."""
    if not unsaved.stalled:
        return None
    return f"{_recordings(unsaved.stalled)} never finished uploading and were left behind."
