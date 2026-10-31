"""Listing and downloading a project's exported files, shared by the host and Editor routes."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from fastapi import Request
from starlette.responses import Response

from podcast_mcp.gui.audio import pinned_audio_response
from podcast_mcp.gui.host_reveal import reveal_in_file_manager
from podcast_mcp.gui.routes.deps import coded_http_error, peer_host
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import ExportFilesService, ServedFile
from podcast_mcp.services.session_sync import is_loopback_host
from podcast_mcp.util.coded_error import CodedFileNotFoundError, guest_message_for_code

EXPORT_RUNNING = guest_message_for_code("export_running")
EXPORT_FILE_GONE = guest_message_for_code("export_file_gone")

REVEAL_REFUSED = "Show in folder only works on the computer that runs ShareCut Studio."
REVEAL_UNAVAILABLE = "This computer couldn't open its file manager."

_DOWNLOAD_HEADERS = {"X-Content-Type-Options": "nosniff"}


def _open_listed(ws: ProjectWorkspace, file_id: str) -> ServedFile:
    try:
        return ExportFilesService(ws).open(file_id)
    except CodedFileNotFoundError as exc:
        if exc.code != "export_file_gone":
            raise
        raise coded_http_error(404, EXPORT_FILE_GONE, code="export_file_gone") from exc


def list_exported_files(ws: ProjectWorkspace) -> dict[str, Any]:
    """``{files: [{id, name, kind, label, bytes, current}]}``; names only, never a host path."""
    return {"files": [asdict(f) for f in ExportFilesService(ws).list()]}


def download_exported_file(request: Request, ws: ProjectWorkspace, file_id: str) -> Response:
    """Stream the listed file *file_id* as an attachment, with Range and ETag.

    The id is looked up in the listing and never joined to a path. It is refused with 409
    while an export of this project is writing, and with 404 when it is not listed.
    """
    if request.app.state.jobs.export_running(ws.path):
        raise coded_http_error(409, EXPORT_RUNNING, code="export_running")
    found = _open_listed(ws, file_id)
    try:
        return pinned_audio_response(
            found.path,
            request=request,
            media_type=found.media_type,
            filename=found.path.name,
            content_disposition_type="attachment",
            headers=_DOWNLOAD_HEADERS,
        )
    except FileNotFoundError as exc:
        raise coded_http_error(404, EXPORT_FILE_GONE, code="export_file_gone") from exc


def reveal_exported_file(request: Request, ws: ProjectWorkspace, file_id: str) -> dict[str, bool]:
    """Show the listed file *file_id* in this computer's file manager; loopback peers only."""
    host = peer_host(request)
    if host is not None and (not host or not is_loopback_host(host.removeprefix("::ffff:"))):
        raise coded_http_error(403, REVEAL_REFUSED, code="reveal_not_allowed")
    found = _open_listed(ws, file_id)
    if not reveal_in_file_manager(found.path):
        raise coded_http_error(409, REVEAL_UNAVAILABLE, code="reveal_unavailable")
    return {"revealed": True}
