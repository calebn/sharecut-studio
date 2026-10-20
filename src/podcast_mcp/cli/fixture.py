from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.engines import TranscriptionEngine
from podcast_mcp.models import CombinedTranscript, Transcript
from podcast_mcp.services.app import ProjectWorkspace

fixture_app = typer.Typer(help="Test fixture utilities.")


def seed_canned_transcript(project_path: Path | str, canned_path: Path | str) -> list[str]:
    """Load canned transcript JSON into a project; returns track ids updated."""
    data = json.loads(Path(canned_path).read_text(encoding="utf-8"))
    per = [Transcript.model_validate(t) for t in data.get("per_track", [])]
    ws = ProjectWorkspace.open(project_path)
    with ws.transaction() as project:
        project.transcripts = per
        combined = data.get("combined")
        project.combined_transcript = (
            CombinedTranscript.model_validate(combined)
            if combined
            else TranscriptionEngine().merge_transcripts(project)
        )
        ws.save()
    return [t.track_id for t in per]


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
