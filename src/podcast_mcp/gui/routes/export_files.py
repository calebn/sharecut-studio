"""Listing and downloading a project's exported files, shared by the host and Editor routes."""

from __future__ import annotations

from collections.abc import Callable, Generator, Mapping
from dataclasses import asdict
from typing import Any
from urllib.parse import quote

import anyio
from fastapi import Request
from starlette.responses import Response, StreamingResponse

from podcast_mcp.export.names import sanitize_export_stem
from podcast_mcp.gui.audio import pinned_audio_response
from podcast_mcp.gui.host_reveal import REVEAL_UNAVAILABLE, reveal_in_file_manager
from podcast_mcp.gui.routes import export_ticket
from podcast_mcp.gui.routes.deps import coded_http_error, require_loopback_peer
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import (
    ArchivePlan,
    ExportFilesService,
    ServedFile,
    plan_archive,
)
from podcast_mcp.util.coded_error import CodedFileNotFoundError, guest_message_for_code
from podcast_mcp.util.zip_stream import stored_zip_chunks

EXPORT_RUNNING = guest_message_for_code("export_running")
EXPORT_FILE_GONE = guest_message_for_code("export_file_gone")

_DOWNLOAD_HEADERS = {"X-Content-Type-Options": "nosniff"}


def _open_listed(ws: ProjectWorkspace, file_id: str, *, host_files: bool) -> ServedFile:
    try:
        return ExportFilesService(ws, host_files=host_files).open(file_id)
    except CodedFileNotFoundError as exc:
        if exc.code != "export_file_gone":
            raise
        raise coded_http_error(404, EXPORT_FILE_GONE, code="export_file_gone") from exc


def _plan(ws: ProjectWorkspace, listed: list[tuple[Any, ServedFile]]) -> ArchivePlan | None:
    return plan_archive(listed, stem=sanitize_export_stem(ws.project.name))


def list_exported_files(
    ws: ProjectWorkspace, *, ticketed: bool = False, host_files: bool = False
) -> dict[str, Any]:
    """``{files: [...], archive: {name, count, bytes, ticket?} | None}``; names only, never a host path.

    With *ticketed* each entry also carries a ``ticket`` that downloads that file as listed,
    and the archive one for the whole archive. *host_files* includes range exports and editable
    DAW packages. One listing pass feeds both the rows and the archive.
    """
    listed = ExportFilesService(ws, host_files=host_files).listed()
    files = []
    for entry, served in listed:
        row = asdict(entry)
        if ticketed:
            row["ticket"] = export_ticket.mint(ws.path, entry.id, served.version)
        files.append(row)
    plan = _plan(ws, listed)
    archive = None
    if plan is not None:
        archive = {"name": plan.name, "count": len(plan.members), "bytes": plan.bytes}
        if ticketed:
            archive["ticket"] = export_ticket.mint(
                ws.path, export_ticket.ARCHIVE_SUBJECT, plan.digest
            )
    return {"files": files, "archive": archive}


def download_exported_file(
    request: Request,
    ws: ProjectWorkspace,
    file_id: str,
    *,
    ticket_version: str | None = None,
    host_files: bool = False,
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
    found = _open_listed(ws, file_id, host_files=host_files)
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
    found = _open_listed(ws, file_id, host_files=True)
    if not reveal_in_file_manager(found.path):
        raise coded_http_error(409, REVEAL_UNAVAILABLE, code="reveal_unavailable")
    return {"revealed": True}


class _ArchiveResponse(StreamingResponse):
    """Streams the chunks, then closes them and runs *release* once, however the response ends.

    Starlette skips ``background`` when the client disconnects and never closes a sync
    iterator, so both happen here.
    """

    def __init__(
        self,
        chunks: Generator[bytes],
        *,
        headers: Mapping[str, str],
        release: Callable[[], None] | None,
    ) -> None:
        super().__init__(chunks, headers=headers)
        self._chunks = chunks
        self._release = release

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            with anyio.CancelScope(shield=True):
                await anyio.to_thread.run_sync(self._finish)

    def _finish(self) -> None:
        try:
            self._chunks.close()
        finally:
            if self._release is not None:
                self._release()


def _attachment(name: str) -> str:
    quoted = quote(name)
    if quoted != name:
        return f"attachment; filename*=utf-8''{quoted}"
    return f'attachment; filename="{name}"'


def download_export_archive(
    request: Request,
    ws: ProjectWorkspace,
    *,
    ticket_version: str | None = None,
    acquire_slot: Callable[[], Callable[[], None] | None] | None = None,
) -> Response:
    """Stream every current file of the listing as one stored zip, with its exact length.

    Refused with 409 while an export of this project is writing and with 404 when nothing
    current can be packed. A *ticket_version* must equal the plan's digest. *acquire_slot*
    takes the caller's stream slot (it raises when none is free) and the slot is released
    when the download ends. A member that changes mid-stream ends the connection short of
    its ``Content-Length``.
    """
    if request.app.state.jobs.export_running(ws.path):
        raise coded_http_error(409, EXPORT_RUNNING, code="export_running")
    plan = _plan(ws, ExportFilesService(ws).listed())
    if plan is None:
        raise coded_http_error(404, EXPORT_FILE_GONE, code="export_file_gone")
    if ticket_version is not None:
        export_ticket.require_unchanged(ticket_version, plan.digest)
    headers = {
        **_DOWNLOAD_HEADERS,
        "Content-Type": "application/zip",
        "Content-Length": str(plan.bytes),
        "Content-Disposition": _attachment(plan.name),
        "Cache-Control": "no-store",
    }
    if request.method == "HEAD":
        return Response(headers=headers)
    release = acquire_slot() if acquire_slot is not None else None
    return _ArchiveResponse(stored_zip_chunks(plan.members), headers=headers, release=release)
