"""``podcast segment``: the library of reusable intros, outros, sponsor reads and stings."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import typer

from podcast_mcp.models.episode import TrackRole
from podcast_mcp.segments.bundle import export_segments, import_bundle
from podcast_mcp.segments.model import SegmentFile, segment_kind
from podcast_mcp.segments.store import AddResult, SegmentStore
from podcast_mcp.segments.summary import damaged_fix, library_rows, show_segment
from podcast_mcp.services.app import ProjectWorkspace
from podcast_mcp.services.document import parse_range, save_segment
from podcast_mcp.services.document_sync import submit_segment_insert

segment_app = typer.Typer(help="The segment library: intros, outros, sponsor reads and stings.")

_PROJECT = typer.Option(..., "--project", "-p", help="Path to episode.sharecut")


def _json(payload: Any) -> str:
    return json.dumps(payload, indent=2, ensure_ascii=False)


def _clock(seconds: float) -> str:
    whole = round(seconds)
    return f"{whole // 60}:{whole % 60:02d}"


def _row(segment: SegmentFile) -> str:
    return f"{segment.id}  {segment.kind}  v{segment.version}  {_clock(segment.duration_sec)}  {segment.name}"


def _added_text(result: AddResult) -> str:
    verb = {
        "added": "Saved",
        "new_version": "Saved a new version of",
        "unchanged": "Already in the library:",
    }[result.status]
    return f"{verb} {result.id} (v{result.version})"


@segment_app.command("save")
def segment_save_cmd(
    project: Path = _PROJECT,
    name: str = typer.Option(..., "--name", "-n", help="What the segment is called"),
    kind: str | None = typer.Option(
        None, "--kind", "-k", help="intro, outro, sponsor, sting or other. Guessed when left out"
    ),
    clips: str | None = typer.Option(None, "--clips", help="Clip ids, separated by commas"),
    time_range: str | None = typer.Option(
        None, "--range", help="A timeline range such as 0:00-0:22"
    ),
    role: TrackRole | None = typer.Option(
        None, "--role", help="The lane role. Defaults to the first clip's track"
    ),
    as_json: bool = typer.Option(False, "--json", help="The result as JSON"),
) -> None:
    """Save clips from an episode into the library, as a copy."""
    result = save_segment(
        ProjectWorkspace.open(project, adopt=False),
        SegmentStore(),
        name=name,
        kind=segment_kind(kind) if kind else None,
        clip_ids=[c.strip() for c in clips.split(",") if c.strip()] if clips else None,
        time_range=parse_range(time_range) if time_range else None,
        role=role,
    )
    typer.echo(_json(result.wire()) if as_json else _added_text(result))


@segment_app.command("list")
def segment_list_cmd(
    as_json: bool = typer.Option(False, "--json"),
    deep: bool = typer.Option(False, "--deep", help="Also verify audio content hashes"),
) -> None:
    """List the segments in the library, newest version of each."""
    store = SegmentStore()
    if as_json:
        typer.echo(_json(library_rows(store, deep=deep)))
        return
    listing = store.scan(deep=deep)
    if not listing.segments and not listing.damaged:
        typer.echo("No segments yet. Save one with `podcast segment save`.")
    for segment in listing.segments:
        typer.echo(_row(segment))
    for damaged in listing.damaged:
        typer.echo(
            f"{damaged.id}  DAMAGED  v{damaged.version}  {damaged.problem} "
            f"{damaged_fix(store, damaged)}"
        )


@segment_app.command("show")
def segment_show_cmd(
    segment_id: str = typer.Argument(..., metavar="ID"),
    as_json: bool = typer.Option(False, "--json"),
) -> None:
    """Show one segment: its layout, level and files."""
    store = SegmentStore()
    if as_json:
        typer.echo(_json(show_segment(store, segment_id)))
        return
    segment = store.get(segment_id)
    versions = list(store.versions(segment_id))
    typer.echo(_row(segment))
    typer.echo(
        f"role {segment.role.value}, fader {segment.fader_db:+.1f} dB, "
        f"{'ducks under dialogue' if segment.duck_under_dialogue else 'no ducking'}"
    )
    if segment.chapter_title:
        typer.echo(f"chapter: {segment.chapter_title}")
    typer.echo(f"versions: {', '.join(f'v{v}' for v in versions)}")
    for clip in segment.clips:
        typer.echo(
            f"  lane {clip.lane}  +{clip.offset_sec:.2f}s  {clip.duration_sec:.2f}s  {clip.audio}"
        )


@segment_app.command("remove")
def segment_remove_cmd(segment_id: str = typer.Argument(..., metavar="ID")) -> None:
    """Delete a segment and all its versions from the library (also a damaged one)."""
    SegmentStore().remove(segment_id)
    typer.echo(f"Removed {segment_id}")


@segment_app.command("export")
def segment_export_cmd(
    segment_id: str = typer.Argument(..., metavar="ID"),
    out: Path = typer.Option(..., "--out", "-o", help="The .sharecutseg file to write"),
) -> None:
    """Write a segment to a .sharecutseg file you can share."""
    path = export_segments(SegmentStore(), [segment_id], out)
    typer.echo(f"Wrote {path}")


@segment_app.command("import")
def segment_import_cmd(
    file: Path = typer.Argument(..., help="A .sharecutseg file"),
    as_json: bool = typer.Option(False, "--json"),
) -> None:
    """Add a .sharecutseg file to the library. The same audio twice changes nothing."""
    result = import_bundle(SegmentStore(), file)
    typer.echo(_json(result.wire()) if as_json else _added_text(result))


@segment_app.command("insert")
def segment_insert_cmd(
    project: Path = typer.Argument(..., help="Path to episode.sharecut"),
    segment_id: str = typer.Argument(..., metavar="SEGMENT", help="A segment id"),
    at: str = typer.Option(
        ..., "--at", help="Where: start, end or a timeline second. Later content moves"
    ),
    version: int | None = typer.Option(None, "--version", help="Segment version. Default: newest"),
    dry_run: bool = typer.Option(
        False, "--dry-run", help="Report what would move and change nothing"
    ),
    as_json: bool = typer.Option(False, "--json", help="The result as JSON"),
) -> None:
    """Insert a saved segment into an episode at start, end or a timeline second."""
    result = submit_segment_insert(
        project, segment_id, at, version=version, dry_run=dry_run, client_id="cli"
    ).model_dump()
    if as_json:
        typer.echo(_json(result))
    elif dry_run:
        typer.echo(
            f"Would insert {result['segment_id']} (v{result['segment_version']}) at "
            f"{result['at']:g} s, {result['duration_sec']:g} s long: the episode would go from "
            f"{result['timeline_duration_before_sec']:g} s to "
            f"{result['timeline_duration_after_sec']:g} s, {result['clips_moved']} clips, "
            f"{len(result['chapters_moved'])} chapters and "
            f"{len(result['comments_moved'])} comments move. Nothing was changed."
        )
    else:
        typer.echo(
            f"Inserted {result['segment_id']} (v{result['segment_version']}) at "
            f"{result['at']:g} s, {result['duration_sec']:g} s long"
        )
