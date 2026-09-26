from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.cli.timed import timed_command
from podcast_mcp.history import HistoryManager
from podcast_mcp.project_merge import ProjectMergeConflict
from podcast_mcp.services import HistoryRerenderError, HistoryService, ProjectWorkspace

history_app = typer.Typer(help="Undo/redo snapshot history (non-destructive edits).")

# A history move with --rerender fails with these after the move is saved; print the advice.
_MOVE_ERRORS = (ValueError, ProjectMergeConflict, HistoryRerenderError)


@history_app.command("list")
def history_list(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    mgr = HistoryManager(ws.path)
    status = mgr.status(ws.project)
    for i, entry in enumerate(mgr.list_entries(ws.project)):
        marker = ">" if i == status.cursor else " "
        typer.echo(f"{marker} [{i}] {entry.label} ({entry.created_at})")


@history_app.command("goto")
def history_goto(
    project: Path = typer.Option(..., "--project"),
    index: int = typer.Option(..., "--index", help="Snapshot index from history list"),
    rerender: bool = typer.Option(
        False,
        "--rerender",
        help="Rebuild stems/premix after goto (slow; omit for segment-play A/B)",
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    try:
        status = HistoryService(ws).goto(index, rerender=rerender)
    except _MOVE_ERRORS as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(
        f"Goto → [{status['cursor']}] {status['current_label']} ({status['total']} snapshots)"
    )


@history_app.command("diff")
def history_diff(
    project: Path = typer.Option(..., "--project"),
    from_index: int | None = typer.Option(None, "--from-index"),
    to_index: int | None = typer.Option(None, "--to-index"),
) -> None:
    ws = ProjectWorkspace.open(project)
    try:
        typer.echo(
            json.dumps(
                HistoryService(ws).diff(from_index=from_index, to_index=to_index),
                indent=2,
            )
        )
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc


@history_app.command("record")
def history_record(
    project: Path = typer.Option(..., "--project"),
    label: str = typer.Option("manual", "--label", help="Snapshot label"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(HistoryService(ws).record(label))


@timed_command("undo")
def undo_cmd(
    project: Path = typer.Option(..., "--project"),
    rerender: bool = typer.Option(False, "--rerender", help="Rebuild premix after undo"),
) -> None:
    ws = ProjectWorkspace.open(project)
    try:
        HistoryService(ws).undo(rerender=rerender)
        status = HistoryManager(ws.path).status(ws.project)
    except _MOVE_ERRORS as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(
        f"Undo → [{status.cursor}] {status.current_label} "
        f"({status.total} snapshots, redo={'yes' if status.can_redo else 'no'})"
    )


@timed_command("redo")
def redo_cmd(
    project: Path = typer.Option(..., "--project"),
    rerender: bool = typer.Option(False, "--rerender", help="Rebuild premix after redo"),
) -> None:
    ws = ProjectWorkspace.open(project)
    try:
        HistoryService(ws).redo(rerender=rerender)
        status = HistoryManager(ws.path).status(ws.project)
    except _MOVE_ERRORS as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(
        f"Redo → [{status.cursor}] {status.current_label} "
        f"({status.total} snapshots, undo={'yes' if status.can_undo else 'no'})"
    )


def history_status_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    typer.echo(json.dumps(HistoryService(ws).status(), indent=2))
