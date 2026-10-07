"""Submit typed document commands from host MCP and CLI (shared journal with the GUI)."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from podcast_mcp.models import EditMode
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document_sync.commands import DocumentCommand, DocumentCommandType
from podcast_mcp.services.document_sync.payloads import validate_payload
from podcast_mcp.services.document_sync.service import DocumentSyncService


def submit_host_document_command(
    project_path: str | Path,
    command_type: DocumentCommandType,
    payload: dict[str, Any] | None = None,
    *,
    client_id: str = "mcp-agent",
    command_id: str | None = None,
) -> dict[str, Any]:
    """Apply via DocumentSyncService so the GUI sees the same command log."""
    validated = validate_payload(command_type, payload)
    ws = ProjectWorkspace.open(project_path)
    svc = DocumentSyncService(ws)
    cmd = DocumentCommand(
        type=command_type,
        payload=validated,
        client_id=client_id,
        role="agent",
        client_seq=None,  # server-assigned: separate CLI/MCP processes never collide
    )
    if command_id is not None:
        if not command_id:
            raise ValueError("command_id must be nonempty")
        cmd.command_id = command_id
    return svc.submit(cmd)


def host_command_result(reply: dict[str, Any]) -> dict[str, Any]:
    """The handler result inside a submit reply (``command.payload.result``)."""
    return ((reply.get("command") or {}).get("payload") or {}).get("result") or {}


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
    return host_command_result(
        submit_host_document_command(project_path, "PasteSegment", payload, client_id=client_id)
    )
