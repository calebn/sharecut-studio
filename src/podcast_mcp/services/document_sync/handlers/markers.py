"""Document-plane chapter / social / envelope / suggest handlers."""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.envelopes import envelope_matches_baseline
from podcast_mcp.services.clip import ClipService
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.edit import EditService
from podcast_mcp.services.pipeline import PipelineService
from podcast_mcp.services.workspace import ProjectWorkspace


def add_chapter(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).add_chapter(float(p["time"]), str(p["title"]))


def update_chapter(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).update_chapter(
        float(p["old_time"]),
        str(p["old_title"]),
        time=float(p["time"]),
        title=str(p["title"]),
    )


def delete_chapter(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).delete_chapter(float(p["time"]), str(p["title"]))


def add_social_clip(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    clip = ClipService(ws).add_manual(
        track_id=str(p["track_id"]),
        start=float(p["start"]),
        end=float(p["end"]),
        title=str(p["title"]) if p.get("title") is not None else None,
    )
    return clip.model_dump()


def update_social_clip(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    clip = ClipService(ws).update_times(
        str(p["id"]),
        start=float(p["start"]),
        end=float(p["end"]),
    )
    return clip.model_dump()


def delete_social_clip(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    n = ClipService(ws).reject([str(p["id"])])
    return {"deleted": n, "id": p["id"]}


def set_envelope(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    """Replace the volume envelope only if ``expected_points`` is still current.

    Runs inside ``ProjectWorkspace.transaction()`` (from ``DocumentSyncService.submit``),
    so no writer in any process commits between this check and the mutation.
    A conflict raises before mutation, history, or the command log.
    """
    track_id = str(p["track_id"])
    ws.reload()
    if not envelope_matches_baseline(ws.project, track_id, p["expected_points"]):
        raise DocumentConflictError(
            f"Envelope on track {track_id!r} changed since this edit started, so the edit "
            "was not applied. Redo it against the current envelope."
        )
    points = list(p.get("points") or [])
    n = PipelineService(ws).set_envelope(track_id, points)
    return {"track_id": p["track_id"], "count": n}


def suggest_pending_edit(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).suggest_pending_edit(
        str(p["track_id"]),
        float(p["start"]),
        float(p["end"]),
        reason=str(p["reason"]) if p.get("reason") is not None else None,
        edit_type=str(p["edit_type"]) if p.get("edit_type") is not None else None,
    )
