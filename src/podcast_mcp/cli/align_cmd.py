"""CLI for conversation-align accept gate."""

from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.cli.timed import timed_command
from podcast_mcp.services import AlignAcceptService, ProjectWorkspace

align_app = typer.Typer(help="Conversation alignment accept gate.")


@align_app.command("status")
@timed_command("align status")
def align_status_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(AlignAcceptService(ws).status(), indent=2))


@align_app.command("brief")
@timed_command("align brief")
def align_brief_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(AlignAcceptService(ws).brief(), indent=2))


@align_app.command("done")
@timed_command("align done")
def align_done_cmd(
    project: Path = typer.Option(..., "--project"),
    notes: str | None = typer.Option(None, "--notes"),
) -> None:
    ws = ProjectWorkspace.open(project)
    result = AlignAcceptService(ws).mark_done(notes=notes, source="cli")
    typer.echo(json.dumps(result, indent=2))


@align_app.command("waive")
@timed_command("align waive")
def align_waive_cmd(
    project: Path = typer.Option(..., "--project"),
    reason: str = typer.Option(..., "--reason"),
) -> None:
    ws = ProjectWorkspace.open(project)
    result = AlignAcceptService(ws).waive(reason=reason, source="cli")
    typer.echo(json.dumps(result, indent=2))
