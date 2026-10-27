from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import typer

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.record import RecordControlService, RecordLandingError, RecordStateError
from podcast_mcp.util.coded_error import CodedValueError

record_app = typer.Typer(help="Host control of a live recording room.")


def _svc(project: Path) -> RecordControlService:
    return RecordControlService(ProjectWorkspace.open(project))


def _invoke(project: Path, op: Callable[[RecordControlService], Any]) -> None:
    try:
        out = op(_svc(project))
    except FileNotFoundError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    except (RecordStateError, RecordLandingError, CodedValueError) as exc:
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


@record_app.command("room-tone")
def record_room_tone(project: Path = typer.Option(..., "--project")) -> None:
    """Ask every recorded device to capture 3 s of room tone now (lobby or stopped)."""
    _invoke(project, lambda ctrl: ctrl.room_tone_countdown())


@record_app.command("target")
def record_target(
    project: Path = typer.Option(..., "--project"),
    target: str = typer.Argument(
        "end",
        help=(
            "Where the session lands: end, or a JSON object for insert "
            '({"kind":"insert","at_sec":12.5}) or replace '
            '({"kind":"replace","from_sec":12.5,"to_sec":20,"track_ids":["p_host"]})'
        ),
    ),
) -> None:
    """Set where this room's session lands (before the first take)."""
    _invoke(project, lambda ctrl: ctrl.set_target(target))


@record_app.command("marker")
def record_marker(
    project: Path = typer.Option(..., "--project"),
    body: str = typer.Option("Marker", "--body", help="Comment text"),
) -> None:
    """Stamp the open take now; `land` turns it into a timeline comment."""
    _invoke(project, lambda ctrl: ctrl.marker(body))


@record_app.command("land")
def record_land(project: Path = typer.Option(..., "--project")) -> None:
    """Land saved full-quality recordings into raw/ and place clips on the timeline."""
    _run(project, "land")


@record_app.command("discard-take")
def record_discard_take(
    project: Path = typer.Option(..., "--project"),
    take_index: int = typer.Option(..., "--take-index"),
) -> None:
    """Delete a terminal take before landing; refused while its recordings are still saving."""
    _invoke(project, lambda ctrl: ctrl.discard_take(take_index))


@record_app.command("tracks")
def record_tracks(project: Path = typer.Option(..., "--project")) -> None:
    """Show which track each person lands on: matched by name to an existing track, new, or ambiguous."""
    _invoke(project, lambda ctrl: ctrl.tracks())


@record_app.command("assign-track")
def record_assign_track(
    project: Path = typer.Option(..., "--project"),
    participant: str = typer.Option(
        ..., "--participant", help="Participant id from `record tracks`"
    ),
    track: str = typer.Option(
        ..., "--track", help='An existing track id, or "new" for a new track'
    ),
) -> None:
    """Correct which track a person's recordings land on, until the session is accepted.

    Staged takes move in one undo step; before landing the choice is remembered. The same track again pins it; `new` dismisses an ambiguous flag.
    """
    _invoke(project, lambda ctrl: ctrl.assign_track(participant, track))
