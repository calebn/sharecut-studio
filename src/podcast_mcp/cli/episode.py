from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.cli.timed import timed_command
from podcast_mcp.services import EpisodeService, ProjectWorkspace, TranscriptService
from podcast_mcp.whisper_models import WHISPER_MODEL_IDS

episode_app = typer.Typer(help="Manage episode projects.")


@episode_app.command("init")
def episode_init(
    dir: Path = typer.Option(..., "--dir", help="Episode workspace directory"),
    name: str = typer.Option("episode", "--name", help="Episode display name"),
) -> None:
    ws = ProjectWorkspace.create(dir, name=name)
    typer.echo(f"Created {ws.path}")


@episode_app.command("add-track")
def track_add(
    project: Path = typer.Option(..., "--project", help="episode.project.json"),
    id: str = typer.Option(..., "--id", help="Track id"),
    file: Path = typer.Option(..., "--file", help="Audio file path"),
    label: str | None = typer.Option(None, "--label", help="Display label"),
    role: str = typer.Option("dialogue", "--role", help="Track role"),
    speaker: str | None = typer.Option(None, "--speaker", help="Speaker name"),
) -> None:
    ws = ProjectWorkspace.open(project)
    msg = EpisodeService(ws).add_track(id, str(file), role=role, speaker=speaker, label=label)
    typer.echo(msg)


@episode_app.command("reorder-track")
def track_reorder(
    project: Path = typer.Option(..., "--project", help="episode.project.json"),
    id: str = typer.Option(..., "--id", help="Track id"),
    index: int = typer.Option(..., "--index", help="0-based destination index"),
) -> None:
    ws = ProjectWorkspace.open(project)
    out = EpisodeService(ws).reorder_track(id, index)
    typer.echo(json.dumps(out))


@timed_command("transcribe")
def transcribe_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str | None = typer.Option(None, "--track", help="Single track id"),
    model: str | None = typer.Option(
        None,
        "--model",
        help=f"Whisper model for this run (options: {', '.join(WHISPER_MODEL_IDS)}).",
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    TranscriptService(ws, model=model).transcribe(track)
    typer.echo("Transcription complete.")


def export_transcript_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    out = TranscriptService(ws).export_markdown()
    typer.echo(f"Wrote {out}")


def info_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(ws.project.model_dump(), indent=2, default=str))
