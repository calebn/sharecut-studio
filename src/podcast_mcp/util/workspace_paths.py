"""Resolve project media paths and keep them inside the workspace."""

from __future__ import annotations

from pathlib import Path

from podcast_mcp.models import EpisodeProject


def resolve_within(root: Path, stored: str, *, base: Path | None = None) -> Path:
    """Resolve *stored* and require the result stays inside *root*.

    Relative *stored* paths join onto *base* (default: *root*). Symlinks are
    followed before the check, so a link that points outside *root* is rejected.
    *root* itself is resolved too, so a symlinked root directory still works.
    Raises ``ValueError`` when the resolved path escapes *root*.
    """
    root_resolved = root.expanduser().resolve()
    path = Path(stored).expanduser()
    if not path.is_absolute():
        path = (base.expanduser().resolve() if base is not None else root_resolved) / path
    resolved = path.resolve()
    if not resolved.is_relative_to(root_resolved):
        raise ValueError(f"path escapes its allowed root: {stored}")
    return resolved


def resolve_under_workspace(project: EpisodeProject, stored: str) -> Path:
    """Join *stored* to the workspace and require the result stays inside it."""
    try:
        return resolve_within(project.workspace_path(), stored)
    except ValueError:
        raise ValueError(f"path must be under workspace: {stored}") from None


def workspace_relpath(project: EpisodeProject, path: Path) -> str:
    ws = project.workspace_path().expanduser().resolve()
    try:
        return str(path.expanduser().resolve().relative_to(ws)).replace("\\", "/")
    except ValueError:
        return str(path)
