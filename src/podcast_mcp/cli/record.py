from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import typer

from podcast_mcp.services.record.control import RecordControlService
from podcast_mcp.services.record.landing import RecordLandingError
from podcast_mcp.services.record.reducer import RecordStateError
from podcast_mcp.services.workspace import ProjectWorkspace

record_app = typer.Typer(help="Host control of a live recording room.")


def _svc(project: Path) -> RecordControlService:
    return RecordControlService(ProjectWorkspace.open(project))


def _invoke(project: Path, op: Callable[[RecordControlService], Any]) -> None:
    try:
        out = op(_svc(project))
    except FileNotFoundError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    except (RecordStateError, RecordLandingError) as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(out, indent=2))


def _run(project: Path, op: str) -> None:
    def call(ctrl: RecordControlService) -> Any:
        if op == "state":
            return ctrl.snapshot()
        if op == "roster":
            return {"participants": ctrl.roster()}
        if op == "start":
            return ctrl.start()
        if op == "pause":
            return ctrl.pause()
        if op == "resume":
            return ctrl.resume()
        if op == "land":
            return ctrl.land()
        return ctrl.stop()

    _invoke(project, call)


@record_app.command("state")
def record_state(project: Path = typer.Option(..., "--project")) -> None:
    """Print the live record-session snapshot."""
    _run(project, "state")


@record_app.command("roster")
def record_roster(project: Path = typer.Option(..., "--project")) -> None:
    """Print connected participants."""
    _run(project, "roster")


@record_app.command("start")
def record_start(project: Path = typer.Option(..., "--project")) -> None:
    """Start a take (host only)."""
    _run(project, "start")


@record_app.command("pause")
def record_pause(project: Path = typer.Option(..., "--project")) -> None:
    """Pause the current take."""
    _run(project, "pause")


@record_app.command("resume")
def record_resume(project: Path = typer.Option(..., "--project")) -> None:
    """Resume a paused take."""
    _run(project, "resume")


@record_app.command("stop")
def record_stop(project: Path = typer.Option(..., "--project")) -> None:
    """Stop the current take."""
    _run(project, "stop")


@record_app.command("land")
def record_land(project: Path = typer.Option(..., "--project")) -> None:
    """Copy ACK'd keepers into raw/ and place clips on the timeline."""
    _run(project, "land")


@record_app.command("discard-take")
def record_discard_take(
    project: Path = typer.Option(..., "--project"),
    take_index: int = typer.Option(..., "--take-index"),
) -> None:
    """Delete a terminal take before landing; refused while upload is in flight."""
    _invoke(project, lambda ctrl: ctrl.discard_take(take_index))
