"""The export render record: which edit head the canonical audio was rendered from."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
from typing import Any

from podcast_mcp.models import EpisodeProject
from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic

RECORD_NAME = "export_render.json"
RECORD_VERSION = 1


def export_render_path(project: EpisodeProject) -> Path:
    return project.artifacts_dir() / RECORD_NAME


def read_export_render(project: EpisodeProject) -> dict[str, Any] | None:
    """The valid record, or None when it is missing, unreadable, malformed or of another version."""
    try:
        record = load_json_object(export_render_path(project))
    except ValueError:
        return None
    if record is None or record.get("version") != RECORD_VERSION:
        return None
    if not isinstance(record.get("edit_head_id"), str):
        return None
    files = record.get("files")
    if not isinstance(files, dict):
        return None
    for stamp in files.values():
        if not (
            isinstance(stamp, list)
            and len(stamp) == 2
            and all(isinstance(part, int) and not isinstance(part, bool) for part in stamp)
        ):
            return None
    return record


def write_export_render(project: EpisodeProject, head: str, audio_paths: Iterable[Path]) -> None:
    """Replace the record with *head* and the size and mtime of each of *audio_paths*."""
    files: dict[str, list[int]] = {}
    for path in audio_paths:
        stat = path.stat()
        files[path.name] = [stat.st_size, stat.st_mtime_ns]
    target = export_render_path(project)
    target.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(
        target,
        {"version": RECORD_VERSION, "edit_head_id": head, "files": files},
    )
