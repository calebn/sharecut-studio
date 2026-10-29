"""Poll metadata for the project and session files the viewer watches."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def project_meta(project_path: Path) -> dict[str, Any]:
    """mtime/size of episode.sharecut plus document.db's server_seq.

    Stats the project file directly and reads ``document_server_seq``, which
    itself is stat + one row on document.db. Neither parses the project, and
    neither creates document.db. ``server_seq`` is omitted when document.db
    cannot be read.
    """
    from podcast_mcp.services.document_sync import document_poll_meta

    return {"path": str(project_path.resolve()), **document_poll_meta(project_path)}


def session_file_meta(project_path: Path) -> dict[str, Any]:
    """Session poll meta for artifacts/session/sync.db (zeros if missing).

    ``mtime_ns`` is the snapshot's ``updated_at_ns`` and ``size`` the serialized
    snapshot's byte length, not file stats (see ``session_meta_at``). Parse-free:
    never opens/parses the project.
    """
    from podcast_mcp.services.session_sync import session_meta

    return session_meta(project_path)
