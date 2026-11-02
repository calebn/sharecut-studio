"""``podcast kit``: a show kit is an ordered list of library segments and where each goes."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import typer

from podcast_mcp.segments.kit import KitAddResult, KitStore
from podcast_mcp.segments.kit_bundle import (
    KitImportResult,
    conflict_policy,
    export_kit,
    import_kit_bundle,
)
from podcast_mcp.segments.kit_summary import kit_rows, parse_entry_spec, save_kit, show_kit
from podcast_mcp.segments.store import SegmentStore
from podcast_mcp.services.document import submit_kit_apply

kit_app = typer.Typer(
    help="Show kits: intro, outro and the rest, applied to an episode in one step."
)


def _json(payload: Any) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False)


def _saved_text(result: KitAddResult) -> str:
    verb = {
        "added": "Saved kit",
        "new_version": "Saved a new version of kit",
        "unchanged": "Already in the library: kit",
        "skipped": "Kept your existing kit",
    }[result.status]
    return f"{verb} {result.id} (v{result.version})"


@kit_app.command("save")
def kit_save_cmd(
    name: str = typer.Argument(..., metavar="NAME", help="What the kit is called"),
    segment: list[str] = typer.Option(
        ...,
        "--segment",
        "-s",
        help="SEGMENT_ID[@VERSION][:AT] in order; AT is start (default), end or a second",
    ),
    as_json: bool = typer.Option(False, "--json", help="The result as JSON"),
) -> None:
    """Save a kit: the segments to put on an episode, in order, and where each goes."""
    result = save_kit(
        KitStore(), SegmentStore(), name, [parse_entry_spec(spec) for spec in segment]
    )
    typer.echo(_json(result.wire()) if as_json else _saved_text(result))


@kit_app.command("list")
def kit_list_cmd(as_json: bool = typer.Option(False, "--json")) -> None:
    """List the kits in the library, newest version of each."""
    rows = kit_rows(KitStore(), SegmentStore())
    if as_json:
        typer.echo(_json(rows))
        return
    if not rows:
        typer.echo("No kits yet. Save one with `podcast kit save`.")
    for row in rows:
        if row.get("damaged"):
            typer.echo(f"{row['id']}  DAMAGED  v{row['version']}  {row['problem']}")
            continue
        gap = f"  {row['missing']} segments missing" if row["missing"] else ""
        typer.echo(f"{row['id']}  v{row['version']}  {row['entries']} segments  {row['name']}{gap}")


@kit_app.command("show")
def kit_show_cmd(
    kit_id: str = typer.Argument(..., metavar="ID"),
    as_json: bool = typer.Option(False, "--json"),
) -> None:
    """Show one kit: its segments in order and where each goes."""
    detail = show_kit(KitStore(), SegmentStore(), kit_id)
    if as_json:
        typer.echo(_json(detail))
        return
    typer.echo(f"{detail['id']}  v{detail['version']}  {detail['name']}")
    typer.echo(f"versions: {', '.join(f'v{v}' for v in detail['versions'])}")
    for row in detail["entries"]:
        pinned = f" v{row['version']}" if row["version"] else ""
        state = "" if row["present"] else "  MISSING"
        note = f"  ({row['note']})" if row.get("note") else ""
        at = row["at"] if isinstance(row["at"], str) else f"{row['at']:g} s"
        typer.echo(f"  {row['position']}. {row['segment_id']}{pinned} at {at}{note}{state}")


@kit_app.command("remove")
def kit_remove_cmd(kit_id: str = typer.Argument(..., metavar="ID")) -> None:
    """Delete a kit and all its versions. The segments it names stay in the library."""
    KitStore().remove(kit_id)
    typer.echo(f"Removed {kit_id}")


@kit_app.command("export")
def kit_export_cmd(
    kit_id: str = typer.Argument(..., metavar="ID"),
    out: Path = typer.Option(..., "--out", "-o", help="The .sharecutkit file to write"),
) -> None:
    """Write a kit and its segments to a .sharecutkit file you can share."""
    path = export_kit(KitStore(), SegmentStore(), kit_id, out)
    typer.echo(f"Wrote {path}")


def _import_text(result: KitImportResult) -> str:
    lines = [_saved_text(result.kit)]
    lines += [
        f"  segment {s.id} (v{s.version}): {s.status.replace('_', ' ')}" for s in result.segments
    ]
    return "\n".join(lines)


@kit_app.command("import")
def kit_import_cmd(
    file: Path = typer.Argument(..., help="A .sharecutkit file"),
    on_conflict: str = typer.Option(
        "new-version",
        "--on-conflict",
        help="When a kit of this name has other segments: new-version (default) or skip",
    ),
    as_json: bool = typer.Option(False, "--json"),
) -> None:
    """Add a .sharecutkit file's segments and kit to the library. Importing twice changes nothing."""
    result = import_kit_bundle(
        KitStore(), SegmentStore(), file, on_conflict=conflict_policy(on_conflict)
    )
    typer.echo(_json(result.wire()) if as_json else _import_text(result))


@kit_app.command("apply")
def kit_apply_cmd(
    kit_id: str = typer.Argument(..., metavar="ID"),
    project: Path = typer.Argument(..., help="Path to episode.sharecut"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Report what would move; change nothing"),
    as_json: bool = typer.Option(False, "--json", help="The result as JSON"),
) -> None:
    """Put every segment of a kit on an episode, in order. Each segment is its own undo step."""
    result = submit_kit_apply(project, kit_id, dry_run=dry_run, client_id="cli")
    if as_json:
        typer.echo(_json(result))
        return
    for entry in result["entries"]:
        verb = "Would insert" if dry_run else "Inserted"
        typer.echo(
            f"{entry['position']}. {verb} {entry['segment_id']} (v{entry['segment_version']}) at "
            f"{entry['at']:g} s, {entry['duration_sec']:g} s long"
        )
    tail = "Nothing was changed." if dry_run else f"{result['undo_steps']} undo steps."
    typer.echo(
        f"The episode {'would go' if dry_run else 'went'} from "
        f"{result['timeline_duration_before_sec']:g} s to "
        f"{result['timeline_duration_after_sec']:g} s. {tail}"
    )
