from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.fixture_seed import seed_canned_transcript

fixture_app = typer.Typer(help="Test fixture utilities.")


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
