"""Submit typed document commands from host MCP and CLI (shared journal with the GUI)."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from podcast_mcp.models import EditMode
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync.commands import (
    ClientRole,
    DocumentCommand,
    DocumentCommandType,
)
from podcast_mcp.services.document_sync.payloads import validate_payload
from podcast_mcp.services.document_sync.service import DocumentSyncService
from podcast_mcp.util.coded_error import CodedValueError

if TYPE_CHECKING:
    from podcast_mcp.services.document import SegmentInsertApplied, SegmentInsertPreview


def submit_host_document_command(
    project_path: str | Path,
    command_type: DocumentCommandType,
    payload: dict[str, Any] | None = None,
    *,
    client_id: str = "mcp-agent",
    command_id: str | None = None,
    role: ClientRole = "agent",
) -> dict[str, Any]:
    """Apply via DocumentSyncService so the GUI sees the same command log."""
    validated = validate_payload(command_type, payload)
    ws = ProjectWorkspace.open(project_path)
    svc = DocumentSyncService(ws)
    cmd = DocumentCommand(
        type=command_type,
        payload=validated,
        client_id=client_id,
        role=role,
        client_seq=None,  # server-assigned: separate CLI/MCP processes never collide
    )
    if command_id is not None:
        if not command_id:
            raise CodedValueError("command_id must be nonempty", code="command_id_empty")
        cmd.command_id = command_id
    return svc.submit(cmd)


def host_command_result(reply: dict[str, Any]) -> dict[str, Any]:
    """The handler result inside a submit reply (``command.payload.result``)."""
    return ((reply.get("command") or {}).get("payload") or {}).get("result") or {}


def submit_host_command_result(
    project_path: str | Path,
    command_type: DocumentCommandType,
    payload: dict[str, Any] | None = None,
    *,
    client_id: str = "mcp-agent",
) -> dict[str, Any]:
    """Submit one host command and return the handler's own result."""
    return host_command_result(
        submit_host_document_command(project_path, command_type, payload, client_id=client_id)
    )


def submit_paste_segment(
    project_path: str | Path,
    insert_at: float,
    clipboard: Mapping[str, Any],
    *,
    mode: EditMode,
    client_id: str = "mcp-agent",
) -> dict[str, Any]:
    """Paste a ``copy_segment`` clipboard at ``insert_at`` in ``mode``, as Studio Paste does.

    The only place host agents build ``PasteSegment``, so a payload change lands here once.
    """
    payload = {
        "insert_at": insert_at,
        "duration": clipboard.get("duration"),
        "extracts": clipboard.get("extracts"),
        "mode": mode.value,
    }
    return submit_host_command_result(project_path, "PasteSegment", payload, client_id=client_id)


def submit_segment_insert(
    project_path: str | Path,
    segment_id: str,
    at: object,
    *,
    version: int | None = None,
    dry_run: bool = False,
    client_id: str = "mcp-agent",
) -> SegmentInsertPreview | SegmentInsertApplied:
    """Insert a library segment (or report what an insert would move), for the CLI and MCP.

    ``at`` is ``start``, ``end`` or seconds, parsed by one function for every caller; ``end``
    is read under the document lock when the insert runs, and in the same way for a dry run.
    The version is pinned here, so the journaled command names the audio that went in even if
    a newer version is saved later. A dry run reads the project in place and writes nothing,
    not even a legacy file rename. Errors: see ``insert_saved_segment``, plus
    ``segment_version_invalid``.
    """
    from podcast_mcp.segments.position import parse_position
    from podcast_mcp.segments.store import SegmentStore
    from podcast_mcp.services.document import SegmentInsertApplied, preview_segment_insert

    store = SegmentStore()
    position = parse_position(at)
    pinned = store.resolve_version(segment_id, version)
    if dry_run:
        return preview_segment_insert(
            ProjectWorkspace.open(project_path, adopt=False),
            segment_id,
            position,
            version=pinned,
            store=store,
        )
    result = submit_host_command_result(
        project_path,
        "InsertSegment",
        {"segment_id": segment_id, "at": position, "version": pinned},
        client_id=client_id,
    )
    return SegmentInsertApplied.model_validate(result)
