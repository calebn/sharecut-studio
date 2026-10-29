from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path

from podcast_mcp.models.episode import (
    EPISODE_PROJECT_FILENAME,
    EpisodeProject,
    project_not_found,
)
from podcast_mcp.project.store import ProjectStore
from podcast_mcp.util.atomic_json import write_json_atomic
from podcast_mcp.util.coded_error import CodedFileNotFoundError, CodedValueError

log = logging.getLogger(__name__)

WORKSPACE_COPY_IGNORE = ("artifacts", "history", "_build", ".git")
RETIRED_PROJECT_FILENAME = "episode.project.json"


def _retired_name_refusal() -> CodedValueError:
    return CodedValueError(
        f"{RETIRED_PROJECT_FILENAME} could not be renamed automatically. "
        f"Rename it to {EPISODE_PROJECT_FILENAME} by hand and open it again.",
        code="project_old_filename",
    )


def resolve_project_path(path: Path | str) -> Path:
    """The ``episode.sharecut`` path *path* names. Pure: it looks at the disk but never changes it.

    A workspace folder maps to its entry file, a retired ``episode.project.json`` maps to
    the sibling entry file, anything else is returned as given. Opening a project goes
    through :func:`adopt_retired_entry_file` first.
    """
    p = Path(path).expanduser().resolve()
    if p.is_dir():
        return p / EPISODE_PROJECT_FILENAME
    if p.name == RETIRED_PROJECT_FILENAME:
        return p.with_name(EPISODE_PROJECT_FILENAME)
    return p


def adopt_retired_entry_file(location: Path | str) -> Path:
    """Rename a workspace's retired ``episode.project.json`` to ``episode.sharecut``; return the entry path.

    The only mutator of the entry file name, called once at each open boundary before the
    first read. *location* is the workspace folder or either entry path. The bytes are
    untouched. When ``episode.sharecut`` already exists it wins and the retired file is
    left alone, with a warning when the retired file is newer (an older build saved after
    the rename). Losing a race to another process doing the same rename counts as
    success. A failed rename raises ``project_old_filename``. Safe to call repeatedly.
    """
    entry = resolve_project_path(location)
    if entry.name != EPISODE_PROJECT_FILENAME:
        return entry
    retired = entry.with_name(RETIRED_PROJECT_FILENAME)
    if not retired.is_file():
        return entry
    if entry.exists():
        _warn_if_retired_is_newer(entry, retired)
        return entry
    try:
        os.rename(retired, entry)
    except OSError as exc:
        if entry.exists():
            return entry
        raise _retired_name_refusal() from exc
    log.info("renamed %s to %s", retired, entry)
    return entry


def _warn_if_retired_is_newer(entry: Path, retired: Path) -> None:
    try:
        newer = retired.stat().st_mtime_ns > entry.stat().st_mtime_ns
    except OSError:
        return
    if newer:
        log.warning(
            "%s is newer than %s and is ignored; edits saved by an older build are not loaded",
            retired,
            entry,
        )


def ensure_utf8_path(path: Path | str) -> None:
    """Raise ``ValueError`` when *path* cannot be written as UTF-8 (a non-UTF-8 folder name)."""
    try:
        str(path).encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError(
            f"project path is not valid UTF-8; rename the folder: {str(path)!a}"
        ) from None


def require_episode_project_file(path: Path | str) -> Path:
    """Resolve *path* (file or workspace dir) and require episode.sharecut basename.

    Used by host GUI ``POST /api/project/open`` and ``pick`` and by the copy operations,
    so it adopts a retired entry file name (see :func:`adopt_retired_entry_file`). CLI
    ``--project``, MCP, and :func:`open_project` still load any project file path the
    caller passes.
    """
    original = Path(path).expanduser()
    resolved = resolve_project_path(path)
    if resolved.name != EPISODE_PROJECT_FILENAME:
        raise ValueError(f"expected {EPISODE_PROJECT_FILENAME}, got {resolved.name!r}")
    adopt_retired_entry_file(resolved)
    if not resolved.is_file():
        if original.is_dir():
            raise CodedFileNotFoundError(
                f"no {EPISODE_PROJECT_FILENAME} in {original.resolve()}",
                code="project_not_found",
            )
        raise project_not_found(resolved)
    return resolved


def open_project(path: Path | str) -> tuple[Path, EpisodeProject]:
    """Load the project at *path*. A reader: openers call :func:`adopt_retired_entry_file` first."""
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
    """Copy an episode tree and rewrite ``workspace_dir``.

    Adopts a retired entry file name in *src_project* first; otherwise nothing is written into it.
    """
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
