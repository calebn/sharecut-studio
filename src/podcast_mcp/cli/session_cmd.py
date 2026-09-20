from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.services.session_control import SessionControlService
from podcast_mcp.services.workspace import ProjectWorkspace

session_app = typer.Typer(help="Read/control shared DAW session state.")


@session_app.command("status")
def session_status(
    project: Path = typer.Option(..., "--project"),
) -> None:
    """Print artifacts/session_state.json (or note if missing)."""
    ws = ProjectWorkspace.open(project)
    state = SessionControlService(ws).get_state()
    if state is None:
        typer.echo(json.dumps({"available": False}, indent=2))
        raise typer.Exit(0)
    typer.echo(json.dumps(state, indent=2))


@session_app.command("seek")
def session_seek(
    project: Path = typer.Option(..., "--project"),
    playhead: float = typer.Option(..., "--playhead", help="Timeline seconds"),
) -> None:
    ws = ProjectWorkspace.open(project)
    state = SessionControlService(ws).seek(playhead)
    typer.echo(json.dumps(state, indent=2))


@session_app.command("stop")
def session_stop(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    state = SessionControlService(ws).stop()
    typer.echo(json.dumps(state, indent=2))


@session_app.command("mode")
def session_mode(
    project: Path = typer.Option(..., "--project"),
    mode: str = typer.Argument(..., help="mix | fx | raw"),
) -> None:
    ws = ProjectWorkspace.open(project)
    try:
        state = SessionControlService(ws).set_mode(mode)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(state, indent=2))


@session_app.command("play")
def session_play(
    project: Path = typer.Option(..., "--project"),
    playing: bool = typer.Option(True, "--playing/--pause"),
) -> None:
    ws = ProjectWorkspace.open(project)
    state = SessionControlService(ws).set_playing(playing)
    typer.echo(json.dumps(state, indent=2))


@session_app.command("region")
def session_region(
    project: Path = typer.Option(..., "--project"),
    start: float = typer.Option(..., "--start"),
    end: float = typer.Option(..., "--end"),
    playing: bool = typer.Option(False, "--playing/--no-playing"),
) -> None:
    ws = ProjectWorkspace.open(project)
    try:
        state = SessionControlService(ws).set_region(start, end, playing=playing)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(state, indent=2))
