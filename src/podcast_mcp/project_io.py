from __future__ import annotations

import json
import shutil
from pathlib import Path

from podcast_mcp.models.episode import EPISODE_PROJECT_FILENAME, EpisodeProject
from podcast_mcp.project_store import ProjectStore
from podcast_mcp.util.atomic_json import write_json_atomic

WORKSPACE_COPY_IGNORE = ("artifacts", "history", "_build", ".git")


def resolve_project_path(path: Path | str) -> Path:
    p = Path(path).expanduser().resolve()
    if p.is_dir():
        return p / EPISODE_PROJECT_FILENAME
    return p


def require_episode_project_file(path: Path | str) -> Path:
    """Resolve *path* (file or workspace dir) and require episode.project.json basename.

    Used by host GUI ``POST /api/project/open`` and ``pick``. CLI ``--project``,
    MCP, and :func:`open_project` still load any JSON path the caller passes.
    """
    original = Path(path).expanduser()
    resolved = resolve_project_path(path)
    if resolved.name != EPISODE_PROJECT_FILENAME:
        raise ValueError(f"expected {EPISODE_PROJECT_FILENAME}, got {resolved.name!r}")
    if not resolved.is_file():
        if original.is_dir():
            raise FileNotFoundError(f"no {EPISODE_PROJECT_FILENAME} in {original.resolve()}")
        raise FileNotFoundError(f"Project not found: {resolved}")
    return resolved


def open_project(path: Path | str) -> tuple[Path, EpisodeProject]:
    resolved = resolve_project_path(path)
    return resolved, ProjectStore(resolved).load()


def rewrite_workspace_dir(project_file: Path) -> Path:
    """Point ``meta.workspace_dir`` at the directory that contains *project_file*."""
    path = Path(project_file)
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"episode project must be a JSON object: {path}")
    data.setdefault("meta", {})["workspace_dir"] = str(path.parent.resolve())
    write_json_atomic(path, data)
    return path


def copy_relocated_workspace(
    src_project: Path | str,
    dest_workspace: Path,
    *,
    ignore: tuple[str, ...] = WORKSPACE_COPY_IGNORE,
) -> Path:
    """Copy an episode tree and rewrite ``workspace_dir``. Never writes into src."""
    src_file = require_episode_project_file(src_project)
    src_ws = src_file.parent.resolve()
    dest_ws = dest_workspace.expanduser().resolve()
    if dest_ws.exists() and dest_ws.samefile(src_ws):
        raise ValueError("output workspace must not be the source project")
    if dest_ws == src_ws or src_ws in dest_ws.parents:
        raise ValueError("output workspace must not be inside the source project")
    dest_file = dest_ws / EPISODE_PROJECT_FILENAME
    if dest_ws.exists():
        raise FileExistsError(f"workspace already exists: {dest_ws}")
    dest_ws.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src_ws, dest_ws, ignore=shutil.ignore_patterns(*ignore))
    return rewrite_workspace_dir(dest_file)
