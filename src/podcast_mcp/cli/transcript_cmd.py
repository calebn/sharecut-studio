from __future__ import annotations

import json
from pathlib import Path

import typer
from filelock import Timeout

from podcast_mcp.cli.context import get_progress
from podcast_mcp.cli.timed import timed_command
from podcast_mcp.services import (
    EditService,
    ProjectWorkspace,
    TranscriptPrecorrectService,
    TranscriptRefineService,
    TranscriptService,
)

transcript_app = typer.Typer(help="Transcript correction and export.")
context_app = typer.Typer(help="Episode transcript context and glossary.")
transcript_app.add_typer(context_app, name="context")


@transcript_app.command("correct")
@timed_command("transcript correct")
def transcript_correct_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str = typer.Option(..., "--track"),
    word_index: int = typer.Option(..., "--word-index"),
    text: str = typer.Option(..., "--text"),
) -> None:
    ws = ProjectWorkspace.open(project)
    EditService(ws).correct_word(track, word_index, text)
    typer.echo("Corrected.")


@transcript_app.command("review")
@timed_command("transcript review")
def transcript_review_cmd(
    project: Path = typer.Option(..., "--project"),
    threshold: float = typer.Option(0.7, "--threshold"),
) -> None:
    ws = ProjectWorkspace.open(project)
    words = EditService(ws).low_confidence_words(threshold)
    typer.echo(json.dumps(words, indent=2))


@transcript_app.command("export-srt")
def transcript_export_srt_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    path = TranscriptService(ws).export_subtitles("srt")
    typer.echo(str(path))


@transcript_app.command("export-vtt")
def transcript_export_vtt_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    path = TranscriptService(ws).export_subtitles("vtt")
    typer.echo(str(path))


@transcript_app.command("precorrect")
def transcript_precorrect_cmd(
    project: Path = typer.Option(..., "--project"),
    dry_run: bool = typer.Option(True, "--dry-run/--apply"),
) -> None:
    ws = ProjectWorkspace.open(project)
    result = TranscriptPrecorrectService(ws).precorrect(
        dry_run=dry_run,
        progress=get_progress(),
    )
    typer.echo(json.dumps(result, indent=2))


@transcript_app.command("refine-status")
def transcript_refine_status_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(TranscriptRefineService(ws).status(), indent=2))


@transcript_app.command("refine-brief")
def transcript_refine_brief_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(TranscriptRefineService(ws).brief(), indent=2))


@transcript_app.command("refine-done")
def transcript_refine_done_cmd(
    project: Path = typer.Option(..., "--project"),
    notes: str | None = typer.Option(None, "--notes"),
) -> None:
    ws = ProjectWorkspace.open(project)
    result = TranscriptRefineService(ws).mark_done(notes=notes, source="cli")
    typer.echo(json.dumps(result, indent=2))


@transcript_app.command("refine-waive")
def transcript_refine_waive_cmd(
    project: Path = typer.Option(..., "--project"),
    reason: str = typer.Option(..., "--reason"),
) -> None:
    ws = ProjectWorkspace.open(project)
    result = TranscriptRefineService(ws).waive(reason=reason, source="cli")
    typer.echo(json.dumps(result, indent=2))


@context_app.command("show")
@timed_command("transcript context show")
def transcript_context_show_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(TranscriptPrecorrectService(ws).get_context(), indent=2))


@context_app.command("set")
@timed_command("transcript context set")
def transcript_context_set_cmd(
    project: Path = typer.Option(..., "--project"),
    context_file: Path | None = typer.Option(
        None, "--file", help="YAML file to merge into transcript_context.yaml"
    ),
    show_title: str | None = typer.Option(None, "--show-title"),
    guest_name: list[str] = typer.Option(None, "--guest-name"),
    term: list[str] = typer.Option(None, "--term"),
) -> None:
    ws = ProjectWorkspace.open(project)
    svc = TranscriptPrecorrectService(ws)
    if not context_file and not (show_title or guest_name or term):
        raise typer.BadParameter("Provide --file or at least one field flag")
    try:
        if context_file:
            import yaml

            data = yaml.safe_load(context_file.read_text(encoding="utf-8")) or {}
            path = svc.update_context(values=data)
        else:
            path = svc.update_context(
                values={"show_title": show_title} if show_title else None,
                guest_names=guest_name,
                terms=term,
            )
    except ValueError as exc:
        raise typer.BadParameter(str(exc)) from exc
    except Timeout as exc:
        typer.echo(f"Transcript context is busy; try again ({exc})", err=True)
        raise typer.Exit(1) from exc
    typer.echo(f"Wrote {path}")
