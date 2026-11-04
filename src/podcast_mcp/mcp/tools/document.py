"""Generic host tools over the document command registry: discover a type, submit it."""

from __future__ import annotations

from mcp.server import MCPServer

from podcast_mcp.mcp.args import JsonObject
from podcast_mcp.mcp.serialize import to_json
from podcast_mcp.services.document_sync import (
    describe_document_commands,
    document_command_schema,
    submit_generic_document_command,
)


def document_command_schema_tool(command_type: str | None = None) -> str:
    """List the document command types, or return one type's payload JSON schema (read only).

    With no ``command_type`` the result lists every type with ``submittable`` (false when
    ``submit_document_command_tool`` refuses it, with the ``refusal`` naming the named tool to
    use), the least ``guest_role`` and any ``host_only_reason``. With a type it adds the
    ``payload_schema`` to build the ``payload`` from. Time fields follow the command's own
    payload: read each field's description before you send it. A baseline field
    (``SetEnvelope.expected_points``, ``SetClipFade.expected``, ``TrimClipEdge.expected_token``)
    says there how to read it.
    """
    if command_type is None:
        return to_json({"commands": [row.model_dump() for row in describe_document_commands()]})
    return to_json(document_command_schema(command_type).model_dump())


def submit_document_command_tool(
    project_path: str,
    command_type: str,
    payload: JsonObject,
    command_id: str | None = None,
) -> str:
    """Submit any document command by type: the edit a named tool does not cover.

    Studio's own edits are document commands, and this reaches every type by name. The
    payload is checked against the type's schema (``document_command_schema_tool``) and an
    unknown top-level field is refused. The edit is a typed journal row and one history step,
    reaches an open Studio tab and is undoable with ``history_undo``. Prefer the named tool when one
    exists: it adds the safety checks and options that tool documents. A type whose named tool
    does work a bare submit cannot (``InsertSegment``) is refused with the tool to use. Reuse
    ``command_id`` only to retry the same edit. Errors: ``document_command_unknown``,
    ``document_command_not_generic``, ``invalid_payload``.
    """
    result = submit_generic_document_command(
        project_path, command_type, payload, command_id=command_id, client_id="mcp:host"
    )
    return to_json(result.model_dump())


def register(mcp: MCPServer) -> None:
    mcp.tool()(document_command_schema_tool)
    mcp.tool()(submit_document_command_tool)
