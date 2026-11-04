from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import ClipService

clips_app = typer.Typer(help="Social clip candidates and export.")


@clips_app.command("propose")
def clips_propose_cmd(
    project: Path = typer.Option(..., "--project"),
    platform: str | None = typer.Option(None, "--platform"),
    max_clips: int | None = typer.Option(None, "--max"),
) -> None:
    ws = ProjectWorkspace.open(project)
    clips = ClipService(ws).propose(platform=platform, max_clips=max_clips)
    typer.echo(f"Proposed {len(clips)} social clip(s).")


@clips_app.command("list")
def clips_list_cmd(
    project: Path = typer.Option(..., "--project"),
    approved: bool | None = typer.Option(
        None, "--approved/--pending", help="Only approved clips, or only pending ones"
    ),
) -> None:
    """Print the clips as JSON with the ids that `clips approve` and `doc submit` take."""
    ws = ProjectWorkspace.open(project)
    rows = [
        {
            "id": c.id,
            "track_id": c.track_id,
            "start": c.start,
            "end": c.end,
            "title": c.title_suggestion,
            "status": "approved" if c.approved else "pending",
        }
        for c in ClipService(ws).list(approved=approved)
    ]
    typer.echo(json.dumps(rows, indent=2))


@clips_app.command("report")
def clips_report_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(ClipService(ws).report())


@clips_app.command("approve")
def clips_approve_cmd(
    project: Path = typer.Option(..., "--project"),
    ids: str = typer.Option(..., "--ids"),
) -> None:
    ws = ProjectWorkspace.open(project)
    ClipService(ws).approve([x.strip() for x in ids.split(",") if x.strip()])
    typer.echo("Approved clips.")


@clips_app.command("export")
def clips_export_cmd(
    project: Path = typer.Option(..., "--project"),
    ids: str | None = typer.Option(None, "--ids"),
) -> None:
    ws = ProjectWorkspace.open(project)
    id_list = [x.strip() for x in ids.split(",") if x.strip()] if ids else None
    try:
        exported = ClipService(ws).export(id_list)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(exported, indent=2))
