from __future__ import annotations

import json
from pathlib import Path

import typer

from podcast_mcp.cli.timed import timed_command
from podcast_mcp.services.play import PlayRequest, PlayService
from podcast_mcp.services.workspace import ProjectWorkspace
from podcast_mcp.util.time_parse import parse_time_sec

play_app = typer.Typer(help="Play audio segments from a project.")


def _parse_optional_time(value: str | None) -> float | None:
    if value is None:
        return None
    return parse_time_sec(value)


@play_app.callback(invoke_without_command=True)
@timed_command("play")
def play_cmd(
    ctx: typer.Context,
    project: Path | None = typer.Option(None, "--project"),
    source: str = typer.Option(
        "premix",
        "--source",
        help="premix, export, track:<id> (raw), or processed:<id> (edits+FX)",
    ),
    start: str | None = typer.Option(None, "--start", help="Start time (sec or HH:MM:SS)"),
    end: str | None = typer.Option(None, "--end", help="End time (sec or HH:MM:SS)"),
    query: str | None = typer.Option(None, "--query", help="Play transcript search match"),
    match: int = typer.Option(0, "--match", help="Match index for --query"),
    padding: float = typer.Option(1.0, "--padding", help="Seconds around query match"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Extract only; print WAV path"),
    player: str | None = typer.Option(None, "--player", help="Override audio player binary"),
    raw: bool = typer.Option(False, "--raw", help="With --query, use raw track:<id> not processed"),
    rerender: bool = typer.Option(
        False,
        "--rerender",
        help="Rebuild stem/premix before play (processed track or premix)",
    ),
    compare: bool = typer.Option(
        False,
        "--compare",
        help="Play each dialogue track then premix for the same range",
    ),
    follow_transcript: bool = typer.Option(
        False,
        "--follow-transcript",
        help="Unmute each track only when that speaker has attributed (non-suppressed) words",
    ),
) -> None:
    if ctx.invoked_subcommand is not None:
        return
    if project is None:
        raise typer.BadParameter("--project is required")
    ws = ProjectWorkspace.open(project)
    start_sec = _parse_optional_time(start)
    end_sec = _parse_optional_time(end)
    if query is None and (start_sec is None or end_sec is None):
        raise typer.BadParameter("--start and --end are required without --query")
    if start_sec is None:
        start_sec = 0.0
    if end_sec is None:
        end_sec = start_sec + 10.0

    result = PlayService(ws).play(
        PlayRequest(
            source=source,
            start_sec=start_sec,
            end_sec=end_sec,
            query=query,
            match_index=match,
            padding_sec=padding,
            raw=raw,
            rerender=rerender,
            compare=compare,
            follow_transcript=follow_transcript,
        ),
        dry_run=dry_run,
        player=player,
    )
    payload = {
        "wav": str(result.wav_path),
        "source": result.source_label,
        "tier": result.tier,
        "start_sec": result.start_sec,
        "end_sec": result.end_sec,
        "player": result.player_cmd,
    }
    if result.compare_segments:
        payload["compare_segments"] = result.compare_segments
    typer.echo(json.dumps(payload, indent=2))


@play_app.command("context")
@timed_command("play context")
def play_context_cmd(
    project: Path = typer.Option(..., "--project"),
    start: str = typer.Option(..., "--start", help="Timeline start (sec or HH:MM:SS)"),
    end: str = typer.Option(..., "--end", help="Timeline end (sec or HH:MM:SS)"),
    skew_warn_ms: float = typer.Option(
        50.0,
        "--skew-warn-ms",
        help="Warn when dialogue tracks' source clocks differ by more than this",
    ),
    detail: str = typer.Option(
        "summary",
        "--detail",
        help="summary | full | visual (visual adds waveform/spectrogram PNGs)",
    ),
) -> None:
    """Per-track captions + clip-skew / stem freshness for a timeline window (v2)."""
    ws = ProjectWorkspace.open(project)
    ctx = PlayService(ws).audition_context(
        parse_time_sec(start),
        parse_time_sec(end),
        skew_warn_sec=skew_warn_ms / 1000.0,
        detail=detail,
    )
    typer.echo(json.dumps(ctx, indent=2))


@play_app.command("ab")
@timed_command("play ab")
def play_ab_cmd(
    project: Path = typer.Option(..., "--project"),
    before_index: int = typer.Option(..., "--before-index", help="History index for A"),
    after_index: int = typer.Option(..., "--after-index", help="History index for B"),
    source: str = typer.Option(
        "premix",
        "--source",
        help="premix, export, track:<id>, or processed:<id>",
    ),
    start: str = typer.Option(..., "--start", help="Start time (sec or HH:MM:SS)"),
    end: str = typer.Option(..., "--end", help="End time (sec or HH:MM:SS)"),
    gap: float = typer.Option(
        0.4,
        "--gap",
        help="Silence between A and B in seconds",
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="Extract concat only"),
    player: str | None = typer.Option(None, "--player", help="Override player binary"),
    rerender: bool = typer.Option(
        False,
        "--rerender",
        help="Rebuild stem/premix before each extract",
    ),
) -> None:
    """Extract the same range at two history snapshots, then play A→gap→B once."""
    ws = ProjectWorkspace.open(project)
    result = PlayService(ws).play_history_ab(
        before_index,
        after_index,
        PlayRequest(
            source=source,
            start_sec=parse_time_sec(start),
            end_sec=parse_time_sec(end),
            rerender=rerender,
        ),
        gap_sec=gap,
        dry_run=dry_run,
        player=player,
    )
    payload = {
        "wav": str(result.wav_path),
        "source": result.source_label,
        "tier": result.tier,
        "start_sec": result.start_sec,
        "end_sec": result.end_sec,
        "gap_sec": gap,
        "before_index": before_index,
        "after_index": after_index,
        "player": result.player_cmd,
    }
    if result.compare_segments:
        payload["compare_segments"] = result.compare_segments
    typer.echo(json.dumps(payload, indent=2))


@play_app.command("pending-preview")
@timed_command("play pending-preview")
def play_pending_preview_cmd(
    project: Path = typer.Option(..., "--project"),
    edit_id: str = typer.Option(..., "--edit-id", help="Pending EditDecision id"),
    mode: str = typer.Option(
        "suggested",
        "--mode",
        help="current | suggested | ab",
    ),
    padding: float = typer.Option(0.5, "--padding", help="Seconds around the cut"),
    gap: float = typer.Option(0.4, "--gap", help="Silence between A and B"),
    source: str = typer.Option("premix", "--source"),
    dry_run: bool = typer.Option(False, "--dry-run"),
    player: str | None = typer.Option(None, "--player"),
    rerender: bool = typer.Option(False, "--rerender"),
) -> None:
    """Hear Current vs Suggested (skip-span) vs A/B for a pending session remove."""
    ws = ProjectWorkspace.open(project)
    result = PlayService(ws).play_pending_preview(
        edit_id,
        mode=mode,
        pad_sec=padding,
        gap_sec=gap,
        source=source,
        dry_run=dry_run,
        player=player,
        rerender=rerender,
    )
    payload = {
        "wav": str(result.wav_path),
        "source": result.source_label,
        "tier": result.tier,
        "start_sec": result.start_sec,
        "end_sec": result.end_sec,
        "mode": mode,
        "edit_id": edit_id,
        "player": result.player_cmd,
    }
    if result.compare_segments:
        payload["compare_segments"] = result.compare_segments
    typer.echo(json.dumps(payload, indent=2))


@play_app.command("compose")
@timed_command("play compose")
def play_compose_cmd(
    project: Path = typer.Option(..., "--project"),
    track_ids: str = typer.Option(
        ...,
        "--track-ids",
        help="Comma-separated track ids to mix (e.g. host,guest)",
    ),
    start: str = typer.Option(..., "--start", help="Timeline start (sec or HH:MM:SS)"),
    end: str = typer.Option(..., "--end", help="Timeline end (sec or HH:MM:SS)"),
    tier: str = typer.Option(
        "processed",
        "--tier",
        help="processed (edits+FX) or raw (source media)",
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="Extract only; print WAV path"),
    player: str | None = typer.Option(None, "--player", help="Override audio player binary"),
    rerender: bool = typer.Option(False, "--rerender", help="Rebuild stems before mix"),
) -> None:
    """Mix a subset of tracks for a timeline window (no mute/FX mutation)."""
    ws = ProjectWorkspace.open(project)
    ids = [part.strip() for part in track_ids.split(",") if part.strip()]
    result = PlayService(ws).play_compose(
        ids,
        parse_time_sec(start),
        parse_time_sec(end),
        tier=tier,
        dry_run=dry_run,
        player=player,
        rerender=rerender,
    )
    typer.echo(
        json.dumps(
            {
                "wav": str(result.wav_path),
                "source": result.source_label,
                "tier": result.tier,
                "start_sec": result.start_sec,
                "end_sec": result.end_sec,
                "track_ids": ids,
                "player": result.player_cmd,
            },
            indent=2,
        )
    )
