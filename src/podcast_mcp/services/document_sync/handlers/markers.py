"""Document-plane chapter / social / envelope / suggest handlers."""

from __future__ import annotations

from typing import Any

from podcast_mcp.edits.envelopes import envelope_matches_baseline
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import ClipService, EditService, TimelineService
from podcast_mcp.services.document_sync.ducking import check_plan_token, plan_ducking
from podcast_mcp.services.document_sync.errors import DocumentConflictError
from podcast_mcp.services.pipeline import PipelineService


def add_chapter(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TimelineService(ws).add_chapter(float(p["time"]), str(p["title"])).model_dump()


def update_chapter(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return (
        TimelineService(ws)
        .update_chapter(
            float(p["old_time"]),
            str(p["old_title"]),
            time=float(p["time"]),
            title=str(p["title"]),
        )
        .model_dump()
    )


def delete_chapter(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return TimelineService(ws).delete_chapter(float(p["time"]), str(p["title"])).model_dump()


def add_social_clip(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    clip = ClipService(ws).add_manual(
        track_id=str(p["track_id"]),
        start=float(p["start"]),
        end=float(p["end"]),
        title=str(p["title"]) if p.get("title") is not None else None,
    )
    return clip.model_dump()


def propose_social_clips(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    clips = ClipService(ws).propose(
        platform=str(p["platform"]) if p.get("platform") is not None else None,
        max_clips=int(p["max_clips"]) if p.get("max_clips") is not None else None,
    )
    return {"proposed": len(clips), "ids": [c.id for c in clips]}


def update_social_clip(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    clip = ClipService(ws).update_times(
        str(p["id"]),
        start=float(p["start"]),
        end=float(p["end"]),
    )
    return clip.model_dump()


def update_social_clip_details(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    clip = ClipService(ws).update_details(
        str(p["id"]),
        title=str(p["title"]) if p.get("title") is not None else None,
        approved=bool(p["approved"]) if p.get("approved") is not None else None,
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
    if ws.project.track_by_id(track_id) is None:
        raise DocumentConflictError(
            f"Volume envelope track {track_id!r} no longer exists. "
            "Select an existing track before retrying."
        )
    if not envelope_matches_baseline(ws.project, track_id, p["expected_points"]):
        raise DocumentConflictError(
            f"Envelope on track {track_id!r} changed since this edit started, so the edit "
            "was not applied. Redo it against the current envelope."
        )
    points = list(p.get("points") or [])
    n = PipelineService(ws).set_envelope(track_id, points)
    return {"track_id": p["track_id"], "count": n}


def plan_ducking_dry_run(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    ws.reload()
    plans = plan_ducking(ws.project, p, ws.effective_config())
    return {**plans.result(with_points=True), "dry_run": True, "applied": False}


def apply_ducking(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    if p.get("dry_run"):
        return plan_ducking_dry_run(ws, p)
    ws.reload()
    plans = plan_ducking(ws.project, p, ws.effective_config())
    check_plan_token(plans, p.get("expected_plan_token"))
    applied = plans.changed
    if applied:
        PipelineService(ws).set_envelopes(
            {t.track_id: [pt._asdict() for pt in t.plan.points] for t in plans.tracks if t.changed},
            operation="apply_ducking",
            label="apply ducking",
        )
    return {**plans.result(with_points=False), "dry_run": False, "applied": applied}


def suggest_pending_edit(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).suggest_pending_edit(
        str(p["track_id"]),
        float(p["start"]),
        float(p["end"]),
        reason=str(p["reason"]) if p.get("reason") is not None else None,
        edit_type=str(p["edit_type"]) if p.get("edit_type") is not None else None,
        author=p.get("_author"),
    )
