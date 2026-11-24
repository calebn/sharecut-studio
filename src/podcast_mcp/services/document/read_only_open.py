"""Open a project for a read-only report, without adopting or writing it."""

from __future__ import annotations

from pathlib import Path

from podcast_mcp.models.episode import ProjectUnreadableError
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.util.coded_error import CodedError


def open_read_only(project_path: Path | str) -> ProjectWorkspace:
    try:
        return ProjectWorkspace.open(project_path, adopt=False)
    except CodedError:
        raise
    except ValueError as exc:
        raise ProjectUnreadableError(
            "The project file is damaged and could not be read (unexpected contents). "
            "Restore it from a backup, or open a copy of the project."
        ) from exc
