from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any

import typer

from podcast_mcp.cli.context import get_progress
from podcast_mcp.cli.timed import timed_command
from podcast_mcp.services import PipelineRunResult, PipelineService, ProjectWorkspace

pipeline_app = typer.Typer(help="Run processing pipeline.")

_SET_HELP = (
    "Run-only config override path=value, repeatable (never saved), "
    "e.g. --set focus.enabled=true --set transcribe.vad.enabled=true"
)


def _overrides(assignments: list[str] | None) -> dict[str, Any]:
    from podcast_mcp.services.pipeline_config import parse_config_assignments

    try:
        return parse_config_assignments(assignments or [])
    except ValueError as exc:
        raise typer.BadParameter(str(exc), param_hint="--set") from exc


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
    retime_words: bool = typer.Option(
        False,
        "--retime-words",
        help="Re-time stored transcripts with the forced aligner from their ASR cache "
        "(no Whisper; hand-edited ones are skipped)",
    ),
    strict: bool = typer.Option(
        True,
        "--strict/--no-strict",
        help="Exit 1 when this run exported and export_qc.json is not ok "
        "(default; --no-strict reports the verdict and exits 0)",
    ),
    assignments: list[str] | None = typer.Option(None, "--set", help=_SET_HELP),
) -> None:
    from podcast_mcp.pipeline.meta import set_by_path
    from podcast_mcp.services.pipeline_config import transcribe_run_config

    overrides = _overrides(assignments)
    if realign:
        set_by_path(overrides, "align.realign", True)
    config = transcribe_run_config(overrides or None, force=force, retime_words=retime_words)
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
        typer.echo("Export QC is not ok; exiting 1 (pass --no-strict to exit 0).", err=True)
        raise typer.Exit(1)


def _echo_run_report(result: PipelineRunResult) -> None:
    for log in result.steps:
        line = f"  {log.status:<5} {log.step}"
        if log.message:
            line = f"{line}: {log.message}"
        typer.echo(line)
    for line in result.qc_report_lines():
        typer.echo(line)
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
    _echo_step_states(rows)


def _echo_step_states(rows: list[dict[str, Any]]) -> None:
    for i, row in enumerate(rows):
        if row["noop_reason"]:
            state = f"no-op ({row['noop_reason']})"
        elif row["enabled"]:
            state = "enabled"
        else:
            state = "disabled"
        typer.echo(f"{i + 1:>2}  {row['id']:<26} {row['kind']:<9} {state}")


@pipeline_app.command("config")
def pipeline_config_cmd(
    assignments: list[str] | None = typer.Option(None, "--set", help=_SET_HELP),
    as_json: bool = typer.Option(False, "--json", help="Emit config + steps as JSON"),
) -> None:
    """Show the effective pipeline config: defaults + --set, params, and step states."""
    from podcast_mcp.pipeline.meta import PARAM_FIELDS
    from podcast_mcp.services.pipeline_config import (
        config_assignment_paths,
        merge_pipeline_config,
        pipeline_step_states,
    )
    from podcast_mcp.util.dicts import get_by_path

    overrides = _overrides(assignments)
    cfg = merge_pipeline_config(overrides)
    rows = pipeline_step_states(cfg)

    if as_json:
        typer.echo(json.dumps({"config": cfg, "overrides": overrides, "steps": rows}, indent=2))
        return

    _echo_step_states(rows)
    overridden_paths = set(config_assignment_paths(overrides))
    for field in PARAM_FIELDS:
        value = get_by_path(cfg, field.path)
        marker = " *" if field.path in overridden_paths else ""
        typer.echo(f"  {field.path} = {json.dumps(value)}{marker}")
    if overrides:
        typer.echo(
            "  (* overridden by --set; pass the same --set to podcast pipeline run "
            "to use these values)"
        )


@pipeline_app.command("analyze")
def pipeline_analyze_cmd(
    project: Path = typer.Option(..., "--project"),
    assignments: list[str] | None = typer.Option(None, "--set", help=_SET_HELP),
    as_json: bool = typer.Option(False, "--json", help="Emit the full Analyze result as JSON"),
) -> None:
    """Run heuristic Analyze against the effective config and print reasons + a patch preview."""
    from podcast_mcp.services import ProjectWorkspace
    from podcast_mcp.services.pipeline_config import merge_pipeline_config, suggest_pipeline_tuning

    overrides = _overrides(assignments)
    base = merge_pipeline_config(overrides)
    ws = ProjectWorkspace.open(project)
    result = suggest_pipeline_tuning(ws.project, base_config=base)

    if as_json:
        typer.echo(json.dumps(result, indent=2))
        return

    _echo_analyze_report(result, project, overrides)


def _echo_analyze_report(result: dict[str, Any], project: Path, overrides: dict[str, Any]) -> None:
    from podcast_mcp.services.pipeline_config import config_assignments
    from podcast_mcp.util.dicts import deep_merge

    reasons = result.get("reasons") or []
    if not reasons:
        typer.echo("Analyze: no findings.")
    for reason in reasons:
        typer.echo(f"  {reason['code']}: {reason['message']}")
        evidence = reason.get("evidence") or {}
        if evidence:
            kv = ", ".join(f"{k}={v}" for k, v in evidence.items())
            typer.echo(f"      evidence: {kv}")
        for step in reason.get("suggested_skip_steps") or []:
            typer.echo(f"      suggest: --skip {step}")

    for row in (result.get("report_summary") or {}).get("tracks") or []:
        tid = row.get("track_id", "?")
        kv = ", ".join(f"{k}={v}" for k, v in row.items() if k != "track_id" and v is not None)
        typer.echo(f"  track {tid}: {kv}")

    patches = result.get("patches") or {}
    if not patches:
        typer.echo("No config changes proposed.")
        return
    # base already holds the analyze --set overrides, so patches omit them; the run
    # line must carry both or it would run a different config than was analyzed.
    parts = [shlex.quote(a) for a in config_assignments(deep_merge(overrides, patches))]
    set_flags = " ".join(f"--set {p}" for p in parts)
    typer.echo(f"Proposed: podcast pipeline run --project {shlex.quote(str(project))} {set_flags}")


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
