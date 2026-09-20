"""Resolve project media paths and keep them inside the workspace."""

from __future__ import annotations

from pathlib import Path

from podcast_mcp.models import EpisodeProject


def resolve_under_workspace(project: EpisodeProject, stored: str) -> Path:
    """Join *stored* to the workspace and require the result stays inside it."""
    ws = project.workspace_path().expanduser().resolve()
    path = Path(stored)
    if not path.is_absolute():
        path = ws / path
    resolved = path.expanduser().resolve()
    if not resolved.is_relative_to(ws):
        raise ValueError(f"path must be under workspace: {stored}")
    return resolved


def workspace_relpath(project: EpisodeProject, path: Path) -> str:
    ws = project.workspace_path().expanduser().resolve()
    try:
        return str(path.expanduser().resolve().relative_to(ws)).replace("\\", "/")
    except ValueError:
        return str(path)
