"""``podcast feed``: read and edit an episode's podcast listing. Thin over ``FeedService``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import typer

from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import FeedService, describe_fields
from podcast_mcp.util.coded_error import CodedValueError

feed_app = typer.Typer(help="The podcast listing: show notes, chapters, people and the feed.")

_PROJECT = typer.Option(..., "--project", "-p", help="Path to episode.sharecut")


def _value(text: str) -> str:
    """``@file`` reads a file's text, so notes and intros can be longer than a shell argument."""
    if not text.startswith("@"):
        return text
    path = Path(text[1:]).expanduser()
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise CodedValueError(
            f"Cannot read {path} as UTF-8 text", code="feed_file_unreadable"
        ) from exc


def _fix_text(fix: dict[str, Any] | None) -> str:
    if fix is None:
        return ""
    if fix["kind"] == "edit":
        edit = fix["edit"]
        return f"podcast feed {edit['op']} {edit['key']}" + (
            f" {edit['value']}" if edit["op"] == "set" else ""
        )
    if fix["kind"] == "input":
        return f"podcast feed set {fix['key']} <value>"
    return f"command: {fix['command']}"


def _show_text(view: dict[str, Any]) -> str:
    lines = [f"File: {view['file']}"]
    for scope in ("channel", "item"):
        for key, fact in view[scope].items():
            source = fact["source"]
            if source["kind"] == "pending":
                lines.append(f"{key}: (missing) {source['why']}")
                continue
            note = source.get("rule") or source.get("file") or source.get("from") or source["kind"]
            if source["kind"] == "pinned":
                note = f"{source['by']} pin" + (", changed since" if source["drifted"] else "")
            lines.append(f"{key}: {fact['value']}  [{note}]")
    for name, fact in view["sections"].items():
        lines.append(
            f"{name}: {'(missing) ' + fact['source']['why'] if fact['value'] is None else fact['source'].get('rule') or fact['source']['kind']}"
        )
    for finding in view["findings"]:
        where = f" {finding['platform']}" if finding["platform"] else ""
        fix = _fix_text(finding["fix"])
        lines.append(
            f"{finding['severity']}{where}: {finding['message']}" + (f"  ({fix})" if fix else "")
        )
    return "\n".join(lines)


@feed_app.command("show")
def feed_show_cmd(
    project: Path = _PROJECT,
    as_json: bool = typer.Option(False, "--json", help="The full view as JSON"),
    xml: bool = typer.Option(
        False, "--xml", help="The feed file's XML. Exits 1 with a warning while a blocker stands"
    ),
    item: bool = typer.Option(False, "--item", help="The bare <item> for your own feed"),
    notes: bool = typer.Option(False, "--notes", help="The show notes as HTML"),
    shows: bool = typer.Option(False, "--shows", help="The show state: none, choose or ready"),
    check: bool = typer.Option(False, "--check", help="Exit 1 when a blocker stands"),
    strict: bool = typer.Option(
        False, "--strict", help="With --check, also fail on warnings and changed pins"
    ),
) -> None:
    """Show how the episode will look in a podcast app and what the feed still needs."""
    service = FeedService(ProjectWorkspace.open(project))
    view = service.read()
    chosen = [
        name
        for name, on in (
            ("json", as_json),
            ("xml", xml),
            ("item", item),
            ("notes", notes),
            ("shows", shows),
        )
        if on
    ]
    if len(chosen) > 1:
        typer.echo("Choose one of --json, --xml, --item, --notes and --shows.", err=True)
        raise typer.Exit(2)
    match chosen:
        case ["json"]:
            typer.echo(json.dumps(view.wire(), indent=2, ensure_ascii=False))
        case ["xml"]:
            typer.echo(service.present("feed_xml"), nl=False)
            blockers = sum(f.severity == "blocker" for f in view.findings)
            if blockers:
                typer.echo(
                    f"Warning: this feed is not valid yet ({blockers} blocker"
                    f"{'' if blockers == 1 else 's'}). Run `podcast feed show` to see them.",
                    err=True,
                )
                raise typer.Exit(1)
        case ["item"]:
            typer.echo(service.present("item_xml"), nl=False)
        case ["notes"]:
            typer.echo(view.notes_html)
        case ["shows"]:
            typer.echo(json.dumps(service.present("show"), indent=2))
        case _:
            typer.echo(_show_text(view.wire()))
    failing = {"blocker", "warn"} if strict else {"blocker"}
    drifted = set(view.drift_detail or ()) if strict else set()
    if check and any(f.severity in failing or f.key in drifted for f in view.findings):
        raise typer.Exit(1)


@feed_app.command("fields")
def feed_fields_cmd(as_json: bool = typer.Option(False, "--json")) -> None:
    """List every listing field, how it is edited and which feed tags it feeds."""
    rows = describe_fields()
    if as_json:
        typer.echo(json.dumps(rows, indent=2))
        return
    for row in rows:
        typer.echo(f"{row['key']}  [{row['scope']}] {row['edit']}\n    {row['help']}")


def _edited(view: Any, key: str) -> str:
    wire = view.wire()
    fact = wire["item"].get(key) or wire["channel"].get(key)
    return json.dumps({"key": key, "fact": fact}, indent=2, ensure_ascii=False)


@feed_app.command("set")
def feed_set_cmd(
    key: str = typer.Argument(..., help="A key from `podcast feed fields`"),
    value: str = typer.Argument(..., help="The value, or @file to read it from a file"),
    project: Path = _PROJECT,
) -> None:
    """Pin a listing value for this episode. The empty string goes back to automatic."""
    view = FeedService(ProjectWorkspace.open(project)).set(key, _value(value), "person")
    typer.echo(_edited(view, key))


@feed_app.command("unset")
def feed_unset_cmd(
    key: str = typer.Argument(..., help="A key from `podcast feed fields`"),
    project: Path = _PROJECT,
) -> None:
    """Drop this episode's pin so the value goes back to automatic."""
    view = FeedService(ProjectWorkspace.open(project)).unset(key, "person")
    typer.echo(_edited(view, key))
