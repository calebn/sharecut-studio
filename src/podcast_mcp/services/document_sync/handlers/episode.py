"""Document-plane episode track ingest handlers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from podcast_mcp.edits.track_ids import slug_track_id
from podcast_mcp.edits.track_media import resolve_workspace_raw_audio
from podcast_mcp.services.episode import EpisodeService
from podcast_mcp.services.workspace import ProjectWorkspace


def _unique_track_id(ws: ProjectWorkspace, preferred: str) -> str:
    base = slug_track_id(preferred)
    existing = {t.id for t in ws.project.tracks}
    if base not in existing:
        return base
    i = 2
    while f"{base}_{i}" in existing:
        i += 1
    return f"{base}_{i}"


def add_track(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    if p.get("track_id") is not None:
        track_id = slug_track_id(str(p["track_id"]))
        if ws.project.track_by_id(track_id) is not None:
            raise ValueError(f"track already exists: {track_id}")
    else:
        preferred = str(p["label"]) if p.get("label") is not None else "track"
        track_id = _unique_track_id(ws, preferred)
    role = str(p.get("role") or "dialogue")
    label = str(p["label"]) if p.get("label") is not None else None
    speaker = str(p["speaker"]) if p.get("speaker") is not None else None
    return EpisodeService(ws).add_empty_track(
        track_id,
        role=role,
        speaker=speaker,
        label=label,
    )


def set_track_media(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    track_id = str(p["track_id"])
    candidate = resolve_workspace_raw_audio(Path(ws.project.workspace_dir), str(p["rel_path"]))
    return EpisodeService(ws).set_track_media(track_id, str(candidate))


def set_track_meta(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EpisodeService(ws).set_track_meta(
        str(p["track_id"]),
        label=str(p["label"]) if p.get("label") is not None else None,
        role=str(p["role"]) if p.get("role") is not None else None,
        speaker=str(p["speaker"]) if p.get("speaker") is not None else None,
    )


def set_track_fader(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EpisodeService(ws).set_track_fader(str(p["track_id"]), float(p["fader_db"]))


def set_track_mute(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EpisodeService(ws).set_track_mute(str(p["track_id"]), bool(p["muted"]))


def remove_track(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EpisodeService(ws).remove_track(str(p["track_id"]))


def reorder_track(ws: ProjectWorkspace, p: dict[str, Any]) -> dict[str, Any]:
    return EpisodeService(ws).reorder_track(str(p["track_id"]), int(p["index"]))
