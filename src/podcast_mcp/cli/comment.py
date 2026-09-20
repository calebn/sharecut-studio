from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.cli.timed import timed_command
from podcast_mcp.services import CommentService, ProjectWorkspace

comment_app = typer.Typer(help="Timeline review comments and action items.")


@comment_app.command("add")
@timed_command("comment add")
def comment_add_cmd(
    project: Path = typer.Option(..., "--project"),
    body: str = typer.Option(..., "--body"),
    author: str = typer.Option(..., "--author"),
    start: float = typer.Option(..., "--start", help="Timeline start seconds"),
    end: float | None = typer.Option(None, "--end", help="Timeline end (span)"),
    tracks: str | None = typer.Option(
        None, "--tracks", help="Comma-separated track ids (empty = session-wide)"
    ),
    action: list[str] | None = typer.Option(None, "--action", help="Action item text (repeatable)"),
    edit_decision_id: str | None = typer.Option(
        None, "--edit-decision-id", help="Link as the Ask thread for a pending edit"
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    track_ids = [x.strip() for x in tracks.split(",") if x.strip()] if tracks else None
    try:
        comment = CommentService(ws).add(
            body=body,
            author=author,
            timeline_start=start,
            timeline_end=end,
            track_ids=track_ids,
            action_texts=list(action or []),
            edit_decision_id=edit_decision_id,
        )
    except (ValueError, KeyError) as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(comment, indent=2))


@comment_app.command("list")
def comment_list_cmd(
    project: Path = typer.Option(..., "--project"),
    include_resolved: bool = typer.Option(True, "--include-resolved/--open-only"),
    open_actions: bool = typer.Option(
        False, "--open-actions", help="Only comments with incomplete action items"
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    rows = CommentService(ws).list(
        include_resolved=include_resolved,
        open_actions_only=open_actions,
    )
    typer.echo(json.dumps(rows, indent=2))


@comment_app.command("get")
def comment_get_cmd(
    project: Path = typer.Option(..., "--project"),
    comment_id: str = typer.Option(..., "--id"),
) -> None:
    ws = ProjectWorkspace.open(project)
    try:
        comment = CommentService(ws).get(comment_id)
    except KeyError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(comment, indent=2))


@comment_app.command("update")
def comment_update_cmd(
    project: Path = typer.Option(..., "--project"),
    comment_id: str = typer.Option(..., "--id"),
    body: str | None = typer.Option(None, "--body"),
    start: float | None = typer.Option(None, "--start"),
    end: float | None = typer.Option(None, "--end"),
    tracks: str | None = typer.Option(None, "--tracks"),
) -> None:
    ws = ProjectWorkspace.open(project)
    track_ids = [x.strip() for x in tracks.split(",") if x.strip()] if tracks is not None else None
    try:
        comment = CommentService(ws).update(
            comment_id,
            body=body,
            track_ids=track_ids,
            timeline_start=start,
            timeline_end=end,
        )
    except (ValueError, KeyError) as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(comment, indent=2))


@comment_app.command("add-action")
def comment_add_action_cmd(
    project: Path = typer.Option(..., "--project"),
    comment_id: str = typer.Option(..., "--id"),
    text: str = typer.Option(..., "--text"),
) -> None:
    ws = ProjectWorkspace.open(project)
    try:
        result = CommentService(ws).add_action(comment_id, text)
    except (ValueError, KeyError) as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(result, indent=2))


@comment_app.command("reply")
@timed_command("comment reply")
def comment_reply_cmd(
    project: Path = typer.Option(..., "--project"),
    comment_id: str = typer.Option(..., "--id"),
    body: str = typer.Option(..., "--body"),
    author: str = typer.Option(..., "--author"),
) -> None:
    ws = ProjectWorkspace.open(project)
    try:
        result = CommentService(ws).add_reply(comment_id, body=body, author=author)
    except (ValueError, KeyError) as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(result, indent=2))


@comment_app.command("resolve")
def comment_resolve_cmd(
    project: Path = typer.Option(..., "--project"),
    comment_id: str = typer.Option(..., "--id"),
    by: str = typer.Option(..., "--by"),
    unresolved: bool = typer.Option(False, "--unresolved"),
) -> None:
    ws = ProjectWorkspace.open(project)
    try:
        comment = CommentService(ws).resolve(comment_id, by=by, resolved=not unresolved)
    except (ValueError, KeyError) as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(comment, indent=2))


@comment_app.command("done")
def comment_done_cmd(
    project: Path = typer.Option(..., "--project"),
    comment_id: str = typer.Option(..., "--id"),
    action_id: str = typer.Option(..., "--action-id"),
    by: str = typer.Option(..., "--by"),
    undone: bool = typer.Option(False, "--undone"),
) -> None:
    ws = ProjectWorkspace.open(project)
    try:
        result = CommentService(ws).set_action_done(comment_id, action_id, done=not undone, by=by)
    except (ValueError, KeyError) as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(result, indent=2))


@comment_app.command("delete")
def comment_delete_cmd(
    project: Path = typer.Option(..., "--project"),
    comment_id: str = typer.Option(..., "--id"),
) -> None:
    ws = ProjectWorkspace.open(project)
    try:
        result = CommentService(ws).delete(comment_id)
    except KeyError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo(json.dumps(result, indent=2))
