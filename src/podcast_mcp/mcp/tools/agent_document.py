"""Submit typed document commands from host MCP/CLI (shared journal with GUI)."""

from __future__ import annotations

from typing import Any

from podcast_mcp.services.document_sync import DocumentSyncService
from podcast_mcp.services.document_sync.commands import (
    DocumentCommand,
    DocumentCommandType,
)
from podcast_mcp.services.document_sync.payloads import validate_payload
from podcast_mcp.services.workspace import ProjectWorkspace


def submit_host_document_command(
    project_path: str,
    command_type: DocumentCommandType,
    payload: dict[str, Any] | None = None,
    *,
    client_id: str = "mcp-agent",
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
    return svc.submit(cmd)
