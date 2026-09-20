from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.cli.context import get_progress
from podcast_mcp.cli.timed import timed_command
from podcast_mcp.pipeline import PIPELINE_STEPS
from podcast_mcp.services import PipelineService, ProjectWorkspace

pipeline_app = typer.Typer(help="Run processing pipeline.")


@pipeline_app.command("run")
def pipeline_run(
    project: Path = typer.Option(..., "--project"),
    from_step: str | None = typer.Option(None, "--from", help="Resume from step"),
    only: str | None = typer.Option(None, "--only", help="Run single step"),
    skip: str | None = typer.Option(
        None,
        "--skip",
        help="Comma-separated step names to skip",
    ),
    unattended: bool = typer.Option(
        False,
        "--unattended",
        help="Batch mode: auto-waive align + transcript refine gates (or set PODCAST_BATCH=1)",
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    skip_steps = [s.strip() for s in skip.split(",") if s.strip()] if skip else None
    step = PipelineService(ws).run(
        from_step=from_step,
        only_step=only,
        skip_steps=skip_steps,
        progress=get_progress(),
        unattended=unattended,
    )
    typer.echo(f"Pipeline complete. Last step: {step}")


@pipeline_app.command("list")
def pipeline_list() -> None:
    for name, _ in PIPELINE_STEPS:
        typer.echo(name)


def render_preview_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    info = PipelineService(ws).render_preview(rerender=True, progress=get_progress())
    typer.echo(json.dumps(info, indent=2))


@pipeline_app.command("export-audio")
@timed_command("export-audio")
def export_audio_cmd(
    project: Path = typer.Option(..., "--project"),
    formats: str | None = typer.Option(
        None,
        "--formats",
        help='JSON array of format specs, e.g. \'[{"ext":"flac","codec":"flac"}]\'',
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    parsed: list[dict] | None = None
    if formats:
        raw = json.loads(formats)
        if not isinstance(raw, list):
            raise typer.BadParameter("--formats must be a JSON array")
        parsed = raw
    paths = PipelineService(ws).export_audio(parsed)
    typer.echo(json.dumps([str(p) for p in paths], indent=2))


@pipeline_app.command("bounce")
@timed_command("bounce")
def bounce_cmd(
    project: Path = typer.Option(..., "--project"),
    tracks: str | None = typer.Option(
        None,
        "--tracks",
        help="Comma-separated track ids (default: all non-muted mixable tracks)",
    ),
    start: float | None = typer.Option(None, "--start", help="Timeline start seconds (optional)"),
    end: float | None = typer.Option(None, "--end", help="Timeline end seconds (optional)"),
    formats: str = typer.Option(
        "wav",
        "--formats",
        help="Comma-separated extensions, e.g. wav,mp3",
    ),
) -> None:
    from podcast_mcp.services import BounceRequest, BounceService

    ws = ProjectWorkspace.open(project)
    track_ids = [t.strip() for t in tracks.split(",") if t.strip()] if tracks else None
    fmt_list = [f.strip().lstrip(".") for f in formats.split(",") if f.strip()]
    paths = BounceService(ws).bounce(
        BounceRequest(
            track_ids=track_ids,
            start_s=start,
            end_s=end,
            formats=fmt_list or ["wav"],
        )
    )
    typer.echo(json.dumps([str(p) for p in paths], indent=2))
