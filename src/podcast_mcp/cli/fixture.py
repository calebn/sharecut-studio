from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import TranscriptService

fixture_app = typer.Typer(help="Test fixture utilities.")


def seed_canned_transcript(project_path: Path | str, canned_path: Path | str) -> list[str]:
    """Load canned transcript JSON into a project; returns track ids updated."""
    data = json.loads(Path(canned_path).read_text(encoding="utf-8"))
    return TranscriptService(ProjectWorkspace.open(project_path)).seed(data)


@fixture_app.command("seed-transcript")
def seed_transcript_cmd(
    project: Path = typer.Option(..., "--project"),
    from_file: Path = typer.Option(
        ...,
        "--from",
        help="Canned transcript JSON (per_track + optional combined)",
    ),
) -> None:
    track_ids = seed_canned_transcript(project, from_file)
    typer.echo(json.dumps({"tracks": track_ids}, indent=2))
