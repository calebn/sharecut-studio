"""``podcast doc``: list, describe and submit any document command by type.

The twin of the host MCP tools ``document_command_schema_tool`` and
``submit_document_command_tool``: the same service functions, so a CLI submit is the same typed
journal row, history step and undo as the tool's.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import typer

from podcast_mcp.services.document_sync import (
    describe_document_commands,
    document_command_schema,
    submit_generic_document_command,
)
from podcast_mcp.util.coded_error import CodedValueError, describe_error

doc_app = typer.Typer(help="Submit any document command by type, from the registry.")


def _fail(exc: Exception) -> typer.Exit:
    typer.echo(describe_error(exc), err=True)
    return typer.Exit(1)


def _read_payload(raw: str) -> dict[str, Any]:
    """The JSON object in ``raw``, or in the file named by ``@path``."""
    text = raw
    if raw.startswith("@"):
        try:
            text = Path(raw[1:]).read_text(encoding="utf-8")
        except OSError as exc:
            raise CodedValueError(
                f"cannot read the payload file {raw[1:]!r}: {exc.strerror or exc}",
                code="invalid_payload",
            ) from exc
    try:
        body = json.loads(text)
    except json.JSONDecodeError as exc:
        raise CodedValueError(
            f"the payload is not valid JSON: {exc.msg} (line {exc.lineno})", code="invalid_payload"
        ) from exc
    if not isinstance(body, dict):
        raise CodedValueError("the payload must be a JSON object", code="invalid_payload")
    return body


@doc_app.command("list")
def doc_list_cmd() -> None:
    """List every document command type and whether `doc submit` accepts it."""
    typer.echo(
        json.dumps(
            {"commands": [row.model_dump() for row in describe_document_commands()]}, indent=2
        )
    )


@doc_app.command("schema")
def doc_schema_cmd(
    command_type: str = typer.Argument(..., metavar="TYPE", help="A type from `podcast doc list`"),
) -> None:
    """Print one type's payload JSON schema."""
    try:
        described = document_command_schema(command_type)
    except CodedValueError as exc:
        raise _fail(exc) from exc
    typer.echo(json.dumps(described.model_dump(), indent=2))


@doc_app.command("submit")
def doc_submit_cmd(
    command_type: str = typer.Argument(..., metavar="TYPE", help="A type from `podcast doc list`"),
    project: Path = typer.Option(..., "--project"),
    payload: str = typer.Option(
        ..., "--payload", help="The payload as a JSON object, or @file to read it from a file"
    ),
    command_id: str | None = typer.Option(
        None, "--command-id", help="Reuse only to retry the same edit"
    ),
) -> None:
    """Submit a document command: a typed journal row, one history step, undoable."""
    try:
        result = submit_generic_document_command(
            project,
            command_type,
            _read_payload(payload),
            command_id=command_id,
            client_id="cli:host",
        )
    except (CodedValueError, ValueError, KeyError) as exc:
        raise _fail(exc) from exc
    typer.echo(json.dumps(result.model_dump(), indent=2))
