from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.cli.context import get_progress
from podcast_mcp.cli.timed import timed_command
from podcast_mcp.services import ProjectWorkspace, SpeakerService

speaker_app = typer.Typer(help="Speaker enrollment and attribution.")


@speaker_app.command("doctor")
@timed_command("speaker doctor")
def speaker_doctor_cmd() -> None:
    typer.echo(json.dumps(SpeakerService.doctor_static(), indent=2))


@speaker_app.command("enroll")
def speaker_enroll_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    speaker: str | None = typer.Option(None, "--speaker"),
    start: float | None = typer.Option(None, "--start"),
    end: float | None = typer.Option(None, "--end"),
    home_track: str | None = typer.Option(None, "--home-track"),
) -> None:
    ws = ProjectWorkspace.open(project)
    result = SpeakerService(ws).enroll(
        track_id=track,
        speaker_id=speaker,
        start_sec=start,
        end_sec=end,
        home_track_id=home_track,
        progress=get_progress(),
    )
    typer.echo(json.dumps(result, indent=2))


@speaker_app.command("profiles")
@timed_command("speaker profiles")
def speaker_profiles_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(SpeakerService(ws).profiles(), indent=2))


@speaker_app.command("score")
def speaker_score_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str = typer.Option(..., "--track"),
    start: float = typer.Option(..., "--start"),
    end: float = typer.Option(..., "--end"),
) -> None:
    ws = ProjectWorkspace.open(project)
    result = SpeakerService(ws).score(track, start, end)
    typer.echo(json.dumps(result, indent=2))


@speaker_app.command("compare")
@timed_command("speaker compare")
def speaker_compare_cmd(
    project: Path = typer.Option(..., "--project"),
    start: float = typer.Option(..., "--start"),
    end: float = typer.Option(..., "--end"),
    track_a: str | None = typer.Option(None, "--track-a"),
    start_a: float | None = typer.Option(None, "--start-a"),
    end_a: float | None = typer.Option(None, "--end-a"),
    track_b: str | None = typer.Option(None, "--track-b"),
    start_b: float | None = typer.Option(None, "--start-b"),
    end_b: float | None = typer.Option(None, "--end-b"),
) -> None:
    ws = ProjectWorkspace.open(project)
    svc = SpeakerService(ws)
    if (
        track_a
        and track_b
        and start_a is not None
        and end_a is not None
        and start_b is not None
        and end_b is not None
    ):
        result = svc.compare_pair(track_a, start_a, end_a, track_b, start_b, end_b)
    else:
        result = svc.compare_window(start, end)
    typer.echo(json.dumps(result, indent=2))


@speaker_app.command("label")
def speaker_label_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str = typer.Option(..., "--track"),
    start: float = typer.Option(..., "--start"),
    end: float = typer.Option(..., "--end"),
    dry_run: bool = typer.Option(True, "--dry-run/--apply"),
) -> None:
    ws = ProjectWorkspace.open(project)
    result = SpeakerService(ws).label(track, start, end, dry_run=dry_run)
    typer.echo(json.dumps(result, indent=2))


@speaker_app.command("set-speaker-count")
def speaker_set_count_cmd(
    project: Path = typer.Option(..., "--project"),
    speakers: int = typer.Option(..., "--speakers"),
) -> None:
    ws = ProjectWorkspace.open(project)
    result = SpeakerService(ws).set_expected_speaker_count(speakers)
    typer.echo(json.dumps(result, indent=2))


@speaker_app.command("attribute")
def speaker_attribute_cmd(
    project: Path = typer.Option(..., "--project"),
    dry_run: bool = typer.Option(True, "--dry-run/--apply"),
) -> None:
    ws = ProjectWorkspace.open(project)
    result = SpeakerService(ws).attribute(dry_run=dry_run, progress=get_progress())
    typer.echo(json.dumps(result, indent=2))


@speaker_app.command("gate-track")
def speaker_gate_track_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track"),
    dry_run: bool = typer.Option(True, "--dry-run/--apply"),
) -> None:
    ws = ProjectWorkspace.open(project)
    result = SpeakerService(ws).gate_track(
        track_id=track,
        dry_run=dry_run,
        progress=get_progress(),
    )
    typer.echo(json.dumps(result, indent=2))
