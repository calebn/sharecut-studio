from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.cli.timed import timed_command
from podcast_mcp.ingest.consolidate import alignment_report
from podcast_mcp.ingest.manifest import IngestManifest
from podcast_mcp.services import IngestService, ProjectWorkspace
from podcast_mcp.services.ingest import (
    import_folder_report_to_dict,
    suggest_alignment_for_manifest,
    suggest_result_to_dict,
    verify_result_to_dict,
    write_alignment_report,
)

ingest_app = typer.Typer(
    help="Align raw audio files and consolidate to one track per speaker (no DAW projects)."
)


def _parse_window(value: str) -> tuple[float, float]:
    if ":" not in value:
        raise typer.BadParameter("window must be START:END in seconds")
    a, b = value.split(":", 1)
    return float(a), float(b)


def _parse_speaker_overrides(items: list[str] | None) -> dict[str, str]:
    overrides: dict[str, str] = {}
    for item in items or []:
        if "=" not in item:
            raise typer.BadParameter("--speaker must be filename=Name")
        key, value = item.split("=", 1)
        key, value = key.strip(), value.strip()
        if not key or not value:
            raise typer.BadParameter("--speaker must be filename=Name")
        overrides[key] = value
    return overrides


@ingest_app.command("import")
@timed_command("ingest import")
def ingest_import_cmd(
    audio_dir: Path = typer.Argument(..., help="Folder of recorder export audio"),
    out: Path | None = typer.Option(None, "--out", help="Write ingest.yaml here"),
    speaker: list[str] | None = typer.Option(
        None,
        "--speaker",
        help="Override speaker label as filename=Name (repeatable)",
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="Scan only; do not write"),
    as_json: bool = typer.Option(False, "--json", help="Print the report as JSON"),
) -> None:
    """Scan a recorder export folder and write ingest.yaml (audio-only, no copy)."""
    result = IngestService.import_recorder_folder(
        audio_dir,
        out_manifest=out,
        speakers_override=_parse_speaker_overrides(speaker),
        dry_run=dry_run,
    )
    payload = import_folder_report_to_dict(result)
    if as_json:
        typer.echo(json.dumps(payload, indent=2))
        return
    typer.echo(f"Scanned {len(result.files)} audio file(s) in {result.audio_dir}")
    if result.vendor_hint != "unknown":
        typer.echo(f"Vendor hint: {result.vendor_hint} (informational; no layout assumptions)")
    for row in result.files:
        typer.echo(
            f"  {row['filename']} → {row['speaker_label']} "
            f"({row['duration_sec']:.1f}s, {row['sample_rate']} Hz, {row['channels']} ch)"
        )
    for row in result.skipped:
        typer.echo(f"  skipped: {row['filename']}")
    for warning in result.warnings:
        typer.echo(f"Warning: {warning}", err=True)
    if result.written:
        typer.echo(f"Wrote {result.out_manifest}")
    elif result.dry_run:
        typer.echo("Dry run — ingest.yaml not written")
    if result.next_steps:
        typer.echo("\nNext:")
        for step in result.next_steps:
            typer.echo(f"  {step}")


@ingest_app.command("report")
def ingest_report_cmd(
    audio_dir: Path = typer.Option(..., "--audio-dir", help="Folder of raw recordings"),
    manifest: Path = typer.Option(..., "--manifest", help="ingest.yaml speaker/source map"),
    analysis_start: float = typer.Option(
        60.0, "--analysis-start", help="Session window start (sec)"
    ),
    analysis_duration: float = typer.Option(
        90.0, "--analysis-duration", help="Window length (sec)"
    ),
    out: Path | None = typer.Option(None, "--out", help="Write JSON report to this path"),
    align_mode: str = typer.Option(
        "auto",
        "--align-mode",
        help="Cross-speaker sync: auto, transcript, or audio",
    ),
    transcript: Path | None = typer.Option(
        None,
        "--transcript",
        help="Per-track transcript JSON for context/anchor alignment",
    ),
) -> None:
    m = IngestManifest.load(manifest)
    rows = alignment_report(
        m,
        audio_dir,
        analysis_start_sec=analysis_start,
        analysis_duration_sec=analysis_duration,
        align_mode=align_mode,  # type: ignore[arg-type]
        transcript_path=transcript,
    )
    if out:
        write_alignment_report(out, rows)
        typer.echo(f"Wrote {out}")
    else:
        typer.echo(json.dumps(rows, indent=2))


@ingest_app.command("suggest")
@timed_command("ingest suggest")
def ingest_suggest_cmd(
    audio_dir: Path = typer.Option(..., "--audio-dir"),
    manifest: Path = typer.Option(..., "--manifest"),
    analysis_start: float = typer.Option(0.0, "--analysis-start"),
    analysis_duration: float = typer.Option(90.0, "--analysis-duration"),
    sweep_min: float = typer.Option(0.0, "--sweep-min"),
    sweep_max: float = typer.Option(240.0, "--sweep-max"),
    sweep_step: float = typer.Option(5.0, "--sweep-step"),
    waveform_top: int = typer.Option(3, "--waveform-top"),
    waveforms: bool = typer.Option(True, "--waveforms/--no-waveforms"),
    diag_dir: Path | None = typer.Option(None, "--diag-dir"),
    out: Path | None = typer.Option(None, "--out"),
) -> None:
    m = IngestManifest.load(manifest)
    result = suggest_alignment_for_manifest(
        m,
        audio_dir,
        analysis_start_sec=analysis_start,
        analysis_duration_sec=analysis_duration,
        sweep_start_min=sweep_min,
        sweep_start_max=sweep_max,
        sweep_step=sweep_step,
        waveform_top_n=waveform_top if waveforms else 0,
        diag_dir=diag_dir,
    )
    payload = suggest_result_to_dict(result)
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        typer.echo(f"Wrote {out}")
    else:
        typer.echo(json.dumps(payload, indent=2))
    typer.echo("\n# Suggested manifest fragment:\n")
    typer.echo(result.yaml_snippet)


@ingest_app.command("verify")
@timed_command("ingest verify")
def ingest_verify_cmd(
    project: Path = typer.Option(..., "--project"),
    window: str = typer.Option("0:90", "--window", help="Timeline window START:END (sec)"),
    fail_on_warn: bool = typer.Option(False, "--fail-on-warn"),
    waveforms: bool = typer.Option(True, "--waveforms/--no-waveforms"),
    diag_dir: Path | None = typer.Option(None, "--diag-dir"),
    out: Path | None = typer.Option(None, "--out"),
) -> None:
    start, end = _parse_window(window)
    ws = ProjectWorkspace.open(project)
    result = IngestService(ws).verify_alignment(
        window_start_sec=start,
        window_end_sec=end,
        write_waveforms=waveforms,
        diag_dir=diag_dir,
    )
    payload = verify_result_to_dict(result)
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        typer.echo(f"Wrote {out}")
    else:
        typer.echo(json.dumps(payload, indent=2))
    if result.status == "fail" or (fail_on_warn and result.status == "warn"):
        raise typer.Exit(code=1)


@ingest_app.command("consolidate")
@timed_command("ingest consolidate")
def ingest_consolidate_cmd(
    audio_dir: Path = typer.Option(..., "--audio-dir", help="Folder of raw recordings"),
    manifest: Path = typer.Option(..., "--manifest", help="ingest.yaml speaker/source map"),
    project: Path = typer.Option(..., "--project", help="episode.project.json"),
    analysis_start: float | None = typer.Option(
        None, "--analysis-start", help="Correlation window start (sec); defaults to --extract-start"
    ),
    analysis_duration: float = typer.Option(90.0, "--analysis-duration"),
    extract_start: float | None = typer.Option(
        None, "--extract-start", help="Episode timeline start (sec)"
    ),
    extract_duration: float | None = typer.Option(
        None,
        "--extract-duration",
        help="Clip length (sec); omit with --extract-start to trim to end of file",
    ),
    align_mode: str = typer.Option(
        "auto",
        "--align-mode",
        help="Cross-speaker sync: auto, transcript, or audio",
    ),
    transcript: Path | None = typer.Option(
        None,
        "--transcript",
        help="Per-track transcript JSON (minimize overlapping speech vs first speaker)",
    ),
) -> None:
    m = IngestManifest.load(manifest)
    if analysis_start is None:
        analysis_start = extract_start if extract_start is not None else 60.0
    ws = ProjectWorkspace.open(project)
    svc = IngestService(ws)
    result = svc.consolidate_to_dialogue_tracks(
        m,
        audio_dir,
        analysis_start_sec=analysis_start,
        analysis_duration_sec=analysis_duration,
        extract_start_sec=extract_start,
        extract_duration_sec=extract_duration,
        align_mode=align_mode,
        transcript_path=transcript,
    )
    applied = svc.apply_consolidated_tracks(result)
    typer.echo(
        f"Consolidated {len(result.speaker_tracks)} speaker track(s): {', '.join(applied.track_ids)}"
    )
    for note in result.ignored_sources:
        typer.echo(f"Note: ignored extra source {note}", err=True)
    for warning in applied.warnings:
        typer.echo(f"Warning: {warning}", err=True)
    if result.cross_speaker_offsets:
        payload = {
            "session_start_in_file_sec": result.session_start_in_file_sec,
            "cross_speaker_offsets_sec": result.cross_speaker_offsets,
            "align_method": result.cross_speaker_align_method,
        }
        if result.transcript_overlap_sec:
            payload["transcript_overlap_sec"] = result.transcript_overlap_sec
        typer.echo(json.dumps(payload, indent=2))
