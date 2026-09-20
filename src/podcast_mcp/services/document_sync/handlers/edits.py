"""Document-plane edit-decision command handlers."""

from __future__ import annotations

from typing import Any

from podcast_mcp.services.edit import EditService
from podcast_mcp.services.workspace import ProjectWorkspace


def approve_edits(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    ids = list(p["ids"])
    count = EditService(ws).approve(ids)
    return {"count": count}


def reject_edits(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    ids = list(p["ids"])
    count = EditService(ws).reject(ids)
    return {"count": count}


def update_pending_edit(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    track_ids = p.get("track_ids")
    edit = EditService(ws).update_pending(
        p["id"],
        start=float(p["start"]),
        end=float(p["end"]),
        snap=bool(p.get("snap", True)),
        track_ids=[str(t) for t in track_ids] if track_ids is not None else None,
    )
    return {"edit": edit.model_dump()}


def restore_applied_edit(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).revert_applied(p["id"])


def set_clip_fade(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).set_clip_fade(
        p["clip_id"],
        int(p["fade_in_ms"]),
        int(p["fade_out_ms"]),
    )


def trim_clip_edge(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).trim_clip_edge(
        p["clip_id"],
        str(p["edge"]),
        float(p["source_sec"]),
        mode=str(p.get("mode", "ripple")),
    )


def roll_clip_join(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).roll_clip_join(
        str(p["left_clip_id"]),
        str(p["right_clip_id"]),
        float(p["delta_sec"]),
    )


def set_join_mode(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).set_join_mode(p["clip_id"], str(p["join_in_mode"]))


def apply_fade_recommendations(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    track_id = p.get("track_id")
    return EditService(ws).apply_fade_recommendations_for_track(
        track_id=str(track_id) if track_id else None,
    )


def set_effect_bypass(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).set_effect_bypass(
        track_id=str(p["track_id"]),
        effect_index=int(p["effect_index"]),
        bypass=bool(p["bypass"]),
    )


def split_at_time(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    from podcast_mcp.services.document_sync.policy import (
        StructuralMutationMode,
        structural_mode_from_payload,
    )

    mode = structural_mode_from_payload(p)
    track_ids = p.get("track_ids")
    tids = [str(t) for t in track_ids] if track_ids is not None else None
    reason = str(p["reason"]) if p.get("reason") is not None else None
    return EditService(ws).split_at_time(
        float(p["at_time"]),
        tids,
        propose=mode is StructuralMutationMode.PROPOSE,
        reason=reason,
    )


def delete_clip(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    from podcast_mcp.services.document_sync.policy import (
        StructuralMutationMode,
        structural_mode_from_payload,
    )

    mode = structural_mode_from_payload(p)
    clip_ids = p.get("clip_ids")
    if clip_ids is None and p.get("clip_id") is not None:
        clip_ids = [p["clip_id"]]
    if not clip_ids:
        raise ValueError("clip_id or clip_ids required")
    reason = str(p["reason"]) if p.get("reason") is not None else None
    return EditService(ws).delete_clips(
        [str(c) for c in clip_ids],
        ripple=False,
        propose=mode is StructuralMutationMode.PROPOSE,
        reason=reason,
    )


def ripple_delete_clip(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    from podcast_mcp.services.document_sync.policy import (
        StructuralMutationMode,
        structural_mode_from_payload,
    )

    mode = structural_mode_from_payload(p)
    clip_ids = p.get("clip_ids")
    if clip_ids is None and p.get("clip_id") is not None:
        clip_ids = [p["clip_id"]]
    if not clip_ids:
        raise ValueError("clip_id or clip_ids required")
    reason = str(p["reason"]) if p.get("reason") is not None else None
    return EditService(ws).delete_clips(
        [str(c) for c in clip_ids],
        ripple=True,
        propose=mode is StructuralMutationMode.PROPOSE,
        reason=reason,
    )


def duplicate_segment(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).duplicate_segment(
        float(p["source_start"]),
        float(p["source_end"]),
        float(p["insert_at"]),
    )


def move_segment(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EditService(ws).move_segment(
        float(p["source_start"]),
        float(p["source_end"]),
        float(p["insert_at"]),
    )


def move_clips(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    raw = p.get("clips") or []
    if not isinstance(raw, list):
        raise ValueError("clips must be a list")
    clips = [dict(x) if not isinstance(x, dict) else x for x in raw]
    return EditService(ws).move_clips(clips)


def paste_segment(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    extracts = p.get("extracts") or []
    if not isinstance(extracts, list):
        raise ValueError("extracts must be a list")
    return EditService(ws).paste_segment(
        float(p["insert_at"]),
        float(p["duration"]),
        [dict(x) for x in extracts],
    )


def ripple_delete_range(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    """Ripple-delete a timeline range (clipboard cut). Apply-only."""
    return EditService(ws).ripple_delete(float(p["start"]), float(p["end"]))
