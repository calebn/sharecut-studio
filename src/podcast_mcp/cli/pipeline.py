from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.cli.context import get_progress
from podcast_mcp.cli.timed import timed_command
from podcast_mcp.services import PipelineRunResult, PipelineService, ProjectWorkspace

pipeline_app = typer.Typer(help="Run processing pipeline.")


@pipeline_app.command("run")
def pipeline_run(
    project: Path = typer.Option(..., "--project"),
    from_step: str | None = typer.Option(None, "--from", help="Resume from step"),
    only: str | None = typer.Option(None, "--only", help="Run single step"),
    skip: str | None = typer.Option(
        None,
        "--skip",
        help="Comma-separated step names to skip",
    ),
    unattended: bool = typer.Option(
        False,
        "--unattended",
        help="Batch mode: auto-waive align + transcript refine gates (or set PODCAST_BATCH=1)",
    ),
    realign: bool = typer.Option(
        False,
        "--realign",
        help="Re-score locked stems in align_tracks (equal length / manifest-pinned offsets)",
    ),
    force: bool = typer.Option(
        False,
        "--force",
        help="Re-run ASR even when transcripts exist (edited ones need an attended run)",
    ),
    strict: bool = typer.Option(
        False,
        "--strict/--no-strict",
        help="Exit 1 when this run exported and export_qc.json is not ok (opt-in until #621)",
    ),
) -> None:
    from podcast_mcp.services.pipeline_config import transcribe_run_config

    config = transcribe_run_config({"align": {"realign": True}} if realign else None, force=force)
    ws = ProjectWorkspace.open(project)
    skip_steps = [s.strip() for s in skip.split(",") if s.strip()] if skip else None
    result = PipelineService(ws).run(
        from_step=from_step,
        only_step=only,
        skip_steps=skip_steps,
        progress=get_progress(),
        unattended=unattended,
        config=config,
    )
    _echo_run_report(result)
    if strict and not result.ok:
        typer.echo("Export QC is not ok; exiting 1 (--strict).", err=True)
        raise typer.Exit(1)


def _echo_run_report(result: PipelineRunResult) -> None:
    for log in result.steps:
        line = f"  {log.status:<5} {log.step}"
        if log.message:
            line = f"{line}: {log.message}"
        typer.echo(line)
    if result.export_qc is not None:
        qc = result.export_qc
        verdict = "ok" if qc.get("ok") else "FAILED"
        issues = qc.get("issues") or []
        warnings = qc.get("warnings") or []
        typer.echo(
            f"Export QC: {verdict} ({len(issues)} issues), "
            f"{len(warnings)} warnings ({result.export_qc_path})"
        )
        for issue in issues:
            typer.echo(f"  - {issue}")
    typer.echo(f"Pipeline complete. Last step: {result.last_step}")


@pipeline_app.command("list")
def pipeline_list(
    as_json: bool = typer.Option(False, "--json", help="Emit step states as JSON"),
) -> None:
    from podcast_mcp.services.pipeline_config import pipeline_step_states

    rows = pipeline_step_states()
    if as_json:
        typer.echo(json.dumps(rows, indent=2))
        return
    for i, row in enumerate(rows):
        if row["noop_reason"]:
            state = f"no-op ({row['noop_reason']})"
        elif row["enabled"]:
            state = "enabled"
        else:
            state = "disabled"
        typer.echo(f"{i + 1:>2}  {row['id']:<26} {row['kind']:<9} {state}")


def render_preview_cmd(
    project: Path = typer.Option(..., "--project"),
) -> None:
    ws = ProjectWorkspace.open(project)
    info = PipelineService(ws).render_preview(rerender=True, progress=get_progress())
    typer.echo(json.dumps(info, indent=2))


@pipeline_app.command("export-audio")
@timed_command("export-audio")
def export_audio_cmd(
    project: Path = typer.Option(..., "--project"),
    formats: str | None = typer.Option(
        None,
        "--formats",
        help='JSON array of format specs, e.g. \'[{"ext":"flac","codec":"flac"}]\'',
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    parsed: list[dict] | None = None
    if formats:
        raw = json.loads(formats)
        if not isinstance(raw, list):
            raise typer.BadParameter("--formats must be a JSON array")
        parsed = raw
    paths = PipelineService(ws).export_audio(parsed)
    typer.echo(json.dumps([str(p) for p in paths], indent=2))


@pipeline_app.command("bounce")
@timed_command("bounce")
def bounce_cmd(
    project: Path = typer.Option(..., "--project"),
    tracks: str | None = typer.Option(
        None,
        "--tracks",
        help="Comma-separated track ids (default: all non-muted mixable tracks)",
    ),
    start: float | None = typer.Option(None, "--start", help="Timeline start seconds (optional)"),
    end: float | None = typer.Option(None, "--end", help="Timeline end seconds (optional)"),
    formats: str = typer.Option(
        "wav",
        "--formats",
        help="Comma-separated extensions, e.g. wav,mp3",
    ),
) -> None:
    from podcast_mcp.services import BounceRequest, BounceService

    ws = ProjectWorkspace.open(project)
    track_ids = [t.strip() for t in tracks.split(",") if t.strip()] if tracks else None
    fmt_list = [f.strip().lstrip(".") for f in formats.split(",") if f.strip()]
    paths = BounceService(ws).bounce(
        BounceRequest(
            track_ids=track_ids,
            start_s=start,
            end_s=end,
            formats=fmt_list or ["wav"],
        )
    )
    typer.echo(json.dumps([str(p) for p in paths], indent=2))
