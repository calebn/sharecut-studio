"""Submit any document command by type, and describe the types, from the registry.

Submits go through ``submit_host_document_command``, so they journal, fan out and undo like the
named tools and never reach a guest. A type whose spec sets ``generic_refusal`` is refused.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

from pydantic import BaseModel, ValidationError

from podcast_mcp.services.document_sync.commands import DocumentCommandType
from podcast_mcp.services.document_sync.host_submit import (
    host_command_result,
    submit_host_document_command,
)
from podcast_mcp.services.document_sync.payloads import coded_payload_error, validate_payload
from podcast_mcp.services.document_sync.registry import COMMANDS, CommandSpec
from podcast_mcp.util.coded_error import CodedValueError


def _spec(command_type: str) -> CommandSpec:
    spec = COMMANDS.get(command_type)
    if spec is None:
        raise CodedValueError(
            f"unknown document command: {command_type}. "
            "List the types with document_command_schema_tool or podcast doc list.",
            code="document_command_unknown",
        )
    return spec


class CommandRow(BaseModel):
    """One document command type as generic submission sees it."""

    type: str
    family: str | None
    guest_role: str | None
    host_only_reason: str | None
    submittable: bool
    refusal: str | None


class CommandSchema(CommandRow):
    """A ``CommandRow`` plus the JSON schema of the type's payload."""

    payload_schema: dict[str, Any]


class GenericSubmitResult(BaseModel):
    """The ack of a generic submit and the handler's own result."""

    ok: bool
    type: str
    command_id: str
    server_seq: int
    history_head_id: str | None
    result: dict[str, Any]
    needs_confirmation: Any = None


def _row(command_type: str, spec: CommandSpec) -> CommandRow:
    return CommandRow(
        type=command_type,
        family=spec.family,
        guest_role=spec.guest.value if spec.guest else None,
        host_only_reason=spec.host_only_reason,
        submittable=spec.generic_refusal is None,
        refusal=spec.generic_refusal,
    )


def describe_document_commands() -> list[CommandRow]:
    """One row per document command type: whether generic submission accepts it, and why not."""
    return [_row(t, COMMANDS[t]) for t in sorted(COMMANDS)]


def document_command_schema(command_type: str) -> CommandSchema:
    """The payload JSON schema of one type, with whether and why generic submission refuses it."""
    spec = _spec(command_type)
    return CommandSchema(
        **_row(command_type, spec).model_dump(), payload_schema=spec.payload.model_json_schema()
    )


def _refuse_unknown_fields(spec: CommandSpec, command_type: str, raw: dict[str, Any]) -> None:
    known = set(spec.payload.model_fields) | {
        field.alias for field in spec.payload.model_fields.values() if field.alias
    }
    unknown = sorted(set(raw) - known)
    if unknown:
        raise CodedValueError(
            f"{command_type}: unknown field {', '.join(unknown)}. "
            "Read the fields with document_command_schema_tool or podcast doc schema.",
            code="invalid_payload",
        )


def submit_generic_document_command(
    project_path: str | Path,
    command_type: str,
    payload: dict[str, Any] | None = None,
    *,
    command_id: str | None = None,
    client_id: str = "mcp-agent",
) -> GenericSubmitResult:
    """Validate and submit one host document command; return its ack and the handler result.

    Errors: ``document_command_unknown``, ``document_command_not_generic``, ``invalid_payload``,
    plus whatever the command's own handler raises (stale targets surface as document
    conflicts). ``command_id`` makes a retry return the first row.
    """
    spec = _spec(command_type)
    if spec.generic_refusal is not None:
        raise CodedValueError(
            f"{command_type} cannot be submitted generically: {spec.generic_refusal}",
            code="document_command_not_generic",
        )
    raw = dict(payload or {})
    _refuse_unknown_fields(spec, command_type, raw)
    try:
        checked = validate_payload(command_type, raw)
    except ValidationError as exc:
        raise coded_payload_error(command_type, exc) from exc
    reply = submit_host_document_command(
        project_path,
        cast(DocumentCommandType, command_type),
        checked,
        client_id=client_id,
        command_id=command_id,
    )
    return GenericSubmitResult(
        ok=reply["ok"],
        type=command_type,
        command_id=reply["command"]["command_id"],
        server_seq=reply["server_seq"],
        history_head_id=reply.get("history_head_id"),
        result=host_command_result(reply),
        needs_confirmation=reply.get("needs_confirmation"),
    )
