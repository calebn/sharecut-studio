"""``podcast track``: per-track edits that are not clip edits."""

from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.cli.cut_speech import cli_actor
from podcast_mcp.services.document_sync import host_command_result, submit_host_document_command

track_app = typer.Typer(help="Per-track edits.")
room_tone_app = typer.Typer(help="A track's room-tone bed, cut from its own audio.")
track_app.add_typer(room_tone_app, name="room-tone")

_PROJECT = typer.Option(..., "--project", "-p", help="Path to episode.sharecut")
_TRACK = typer.Option(..., "--track", help="Track id")


@room_tone_app.command("extract")
def room_tone_extract_cmd(project: Path = _PROJECT, track: str = _TRACK) -> None:
    """Cut a bed for the track from its quiet stretch, in one undo step.

    A recorded or assigned bed, or audio unchanged since the last extraction, is left as it
    is; with no clean stretch the reply says why.
    """
    reply = submit_host_document_command(
        project, "ExtractRoomToneBed", {"track_id": track}, client_id=cli_actor(), role="cli"
    )
    typer.echo(json.dumps(host_command_result(reply), indent=2))


@room_tone_app.command("clear")
def room_tone_clear_cmd(project: Path = _PROJECT, track: str = _TRACK) -> None:
    """Take the track's extracted bed off, in one undo step. A recorded bed is never removed."""
    reply = submit_host_document_command(
        project,
        "ClearExtractedRoomToneBed",
        {"track_id": track},
        client_id=cli_actor(),
        role="cli",
    )
    typer.echo(json.dumps(host_command_result(reply), indent=2))
