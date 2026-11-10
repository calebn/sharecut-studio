"""Listing and downloading a project's exported files, shared by the host and Editor routes."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict
from typing import Any

from fastapi import Request
from starlette.responses import Response

from podcast_mcp.gui.audio import pinned_audio_response
from podcast_mcp.gui.host_reveal import REVEAL_UNAVAILABLE, reveal_in_file_manager
from podcast_mcp.gui.routes import export_ticket
from podcast_mcp.gui.routes.deps import coded_http_error, require_loopback_peer
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import ExportFilesService, ServedFile
from podcast_mcp.util.coded_error import CodedFileNotFoundError, guest_message_for_code

EXPORT_RUNNING = guest_message_for_code("export_running")
EXPORT_FILE_GONE = guest_message_for_code("export_file_gone")

_DOWNLOAD_HEADERS = {"X-Content-Type-Options": "nosniff"}


def _open_listed(ws: ProjectWorkspace, file_id: str, *, bounces: bool) -> ServedFile:
    try:
        return ExportFilesService(ws, bounces=bounces).open(file_id)
    except CodedFileNotFoundError as exc:
        if exc.code != "export_file_gone":
            raise
        raise coded_http_error(404, EXPORT_FILE_GONE, code="export_file_gone") from exc


def list_exported_files(
    ws: ProjectWorkspace, *, ticketed: bool = False, bounces: bool = False
) -> dict[str, Any]:
    """``{files: [{id, name, kind, label, bytes, current, format}]}``; names only, never a host path.

    With *ticketed* each entry also carries a ``ticket`` that downloads that file as listed.
    *bounces* adds the range exports and is for the host only.
    """
    files = []
    for entry, version in ExportFilesService(ws, bounces=bounces).listed():
        row = asdict(entry)
        if ticketed:
            row["ticket"] = export_ticket.mint(ws.path, entry.id, version)
        files.append(row)
    return {"files": files}


def download_exported_file(
    request: Request,
    ws: ProjectWorkspace,
    file_id: str,
    *,
    ticket_version: str | None = None,
    bounces: bool = False,
    acquire_slot: Callable[[], Callable[[], None] | None] | None = None,
) -> Response:
    """Stream the listed file *file_id* as an attachment, with Range and ETag.

    The id is looked up in the listing and never joined to a path. It is refused with 409
    while an export of this project is writing, and with 404 when it is not listed. A *ticket_version*
    must match the file as it is now. For an audio file *acquire_slot* takes the caller's stream slot (it
    raises when none is free) and the slot is released when the download ends.
    """
    if request.app.state.jobs.export_running(ws.path):
        raise coded_http_error(409, EXPORT_RUNNING, code="export_running")
    found = _open_listed(ws, file_id, bounces=bounces)
    if ticket_version is not None:
        export_ticket.require_unchanged(ticket_version, found.version)
    slot = acquire_slot() if acquire_slot is not None and found.kind == "audio" else None
    try:
        return pinned_audio_response(
            found.path,
            request=request,
            media_type=found.media_type,
            filename=found.path.name,
            content_disposition_type="attachment",
            headers=_DOWNLOAD_HEADERS,
            on_release=slot,
        )
    except FileNotFoundError as exc:
        raise coded_http_error(404, EXPORT_FILE_GONE, code="export_file_gone") from exc


def reveal_exported_file(request: Request, ws: ProjectWorkspace, file_id: str) -> dict[str, bool]:
    """Show the listed file *file_id* in this computer's file manager; loopback peers only."""
    require_loopback_peer(request)
    found = _open_listed(ws, file_id, bounces=True)
    if not reveal_in_file_manager(found.path):
        raise coded_http_error(409, REVEAL_UNAVAILABLE, code="reveal_unavailable")
    return {"revealed": True}
