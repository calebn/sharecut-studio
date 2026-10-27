"""Mint preflight: does the current room hold a stopped take that is not saved to the episode?"""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.session_suggestions import session_suggestion_for
from podcast_mcp.models import EpisodeProject
from podcast_mcp.services.record.landing import STAGED_TARGET_KINDS
from podcast_mcp.services.record.service import RecordSessionService, _store_for
from podcast_mcp.services.record.state import RecordSnapshot
from podcast_mcp.services.record.upload import RecordUploadService


def unlanded_takes(project: EpisodeProject) -> int:
    """Stopped takes of the active room that still have full-quality recordings to land.

    Discarded takes are not counted (the upload status drops them). A staged session whose
    suggestion is already accepted or skipped has nothing left to save.
    """
    session_id = RecordSessionService.active_session_id(project)
    raw = _store_for(project).get_snapshot() if session_id else None
    if not session_id or not raw:
        return 0
    snap = RecordSnapshot.model_validate(raw)
    stopped = {t.take_index for t in snap.takes if t.stopped_wall_ms is not None}
    if snap.target.kind in STAGED_TARGET_KINDS:
        held = session_suggestion_for(project, session_id)
        if held is not None and held.status != "pending":
            return 0
    segments = RecordUploadService(project).status(session_id=session_id)["segments"]
    return len(
        {
            int(row["take_index"])
            for row in segments
            if row.get("file_ack") and not row.get("landed") and int(row["take_index"]) in stopped
        }
    )


def unlanded_take_fields(count: int) -> dict[str, Any]:
    return {"unlanded_take": count > 0, "unlanded_takes": count}


def with_unlanded_takes(project: EpisodeProject, snapshot: dict[str, Any]) -> dict[str, Any]:
    """The host record snapshot plus the mint preflight fields."""
    return {**snapshot, **unlanded_take_fields(unlanded_takes(project))}


def describe_unlanded_takes(count: int) -> str:
    """One plain sentence for CLI, MCP and HTTP callers; the same words everywhere."""
    what = "1 stopped take is" if count == 1 else f"{count} stopped takes are"
    return (
        f"{what} not saved to the episode yet, and a new room leaves "
        f"{'it' if count == 1 else 'them'} behind. Save first (land-first) or start anyway."
    )
