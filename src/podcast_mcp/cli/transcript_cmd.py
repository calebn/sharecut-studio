from __future__ import annotations

import json
from pathlib import Path

import typer
import yaml
from filelock import Timeout

from podcast_mcp.cli.context import get_progress
from podcast_mcp.cli.timed import timed_command
from podcast_mcp.config import load_defaults
from podcast_mcp.export.transcript import CaptionLimits, resolve_caption_limits
from podcast_mcp.services import (
    EditService,
    ProjectWorkspace,
    TranscriptPrecorrectService,
    TranscriptRefineService,
    TranscriptService,
    TranscriptTextChangedError,
)
from podcast_mcp.util.project_state import TRANSCRIPT_CONTEXT_BUSY_MESSAGE

transcript_app = typer.Typer(help="Transcript correction and export.")
context_app = typer.Typer(help="Episode transcript context and glossary.")
transcript_app.add_typer(context_app, name="context")


def _caption_limits(
    *,
    max_duration_sec: float | None,
    max_chars_per_line: int | None,
    max_lines: int | None,
) -> CaptionLimits:
    """Pipeline defaults' ``export.captions``, overridden by any CLI flags given.

    A given flag is validated here (bad value -> ``typer.BadParameter``, a usage error,
    exit 2); an invalid ``export.captions`` yaml default is a domain ``ValueError`` from
    ``CaptionLimits`` itself, exit 1 (#790).
    """
    if max_duration_sec is not None and max_duration_sec <= 0:
        raise typer.BadParameter("must be > 0", param_hint="'--max-duration-sec'")
    if max_lines is not None and max_lines < 1:
        raise typer.BadParameter("must be >= 1", param_hint="'--max-lines'")
    base = resolve_caption_limits(load_defaults().get("export", {}))
    if max_duration_sec is not None and max_duration_sec < base.min_duration_sec:
        # Caught here, against the flag, rather than left to CaptionLimits below: that
        # raises a domain ValueError naming min_duration_sec, a yaml key this user never
        # set (#816). The value is still worth surfacing, just not as something to flag.
        raise typer.BadParameter(
            f"must be >= the configured min_duration_sec ({base.min_duration_sec})",
            param_hint="'--max-duration-sec'",
        )
    return CaptionLimits(
        max_duration_sec=base.max_duration_sec if max_duration_sec is None else max_duration_sec,
        max_chars_per_line=(
            base.max_chars_per_line if max_chars_per_line is None else max_chars_per_line
        ),
        max_lines=base.max_lines if max_lines is None else max_lines,
        min_duration_sec=base.min_duration_sec,
        merge_max_gap_sec=base.merge_max_gap_sec,
    )


@transcript_app.command("correct")
@timed_command("transcript correct")
def transcript_correct_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str = typer.Option(..., "--track"),
    word_index: int = typer.Option(..., "--word-index"),
    text: str = typer.Option(..., "--text"),
    expected_text: str | None = typer.Option(
        None,
        "--expected-text",
        help="Word text you read at --word-index; refuse the fix if it changed meanwhile (#650).",
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    try:
        EditService(ws).correct_word(track, word_index, text, expected_text=expected_text)
    except TranscriptTextChangedError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(1) from exc
    typer.echo("Corrected.")


@transcript_app.command("correct-phrase")
@timed_command("transcript correct-phrase")
def transcript_correct_phrase_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str = typer.Option(..., "--track"),
    start_word_index: int = typer.Option(..., "--start-word-index"),
    end_word_index: int = typer.Option(..., "--end-word-index"),
    text: str = typer.Option(..., "--text"),
    expected_text: str | None = typer.Option(
        None,
        "--expected-text",
        help=(
            "Space-joined words you read for this range; refuse the fix if they "
            "changed meanwhile (#650)."
        ),
    ),
) -> None:
    """Replace a word range's text in one undo step.

    Re-times the replaced words evenly across the span, so word-level
    ``correct`` is a better fit for casing/phrase fixes that must keep
    original timings; use this for merging split ASR tokens or short phrases.
    """
    ws = ProjectWorkspace.open(project)
    EditService(ws).correct_phrase(
        track, start_word_index, end_word_index, text, expected_text=expected_text
    )
    typer.echo("Corrected.")


@transcript_app.command("suppress-word")
@timed_command("transcript suppress-word")
def transcript_suppress_word_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str = typer.Option(..., "--track"),
    word_index: int = typer.Option(..., "--word-index"),
    suppressed: bool | None = typer.Option(
        None,
        "--suppressed/--unsuppressed",
        help="Suppress (default) or restore (unsuppress) the word. Mutually exclusive with --automatic.",
    ),
    automatic: bool = typer.Option(
        False,
        "--automatic",
        help=(
            "Clear the word's suppression lock instead of setting it (#824): `suppressed` is "
            "left as is until the next reconcile pass. Mutually exclusive with "
            "--suppressed/--unsuppressed."
        ),
    ),
    expected_text: str | None = typer.Option(
        None,
        "--expected-text",
        help="Word text you read at --word-index; refuse the change if it changed meanwhile (#744).",
    ),
) -> None:
    """Suppress, unsuppress, or return to automatic one per-track word (text only; audio unchanged)."""
    if automatic and suppressed is not None:
        raise typer.BadParameter(
            "--automatic is mutually exclusive with --suppressed/--unsuppressed."
        )
    ws = ProjectWorkspace.open(project)
    if automatic:
        result = EditService(ws).set_word_automatic(track, word_index, expected_text=expected_text)
    else:
        result = EditService(ws).set_word_suppressed(
            track,
            word_index,
            suppressed if suppressed is not None else True,
            expected_text=expected_text,
        )
    typer.echo(json.dumps(result, indent=2))


@transcript_app.command("cleanup-batch")
@timed_command("transcript cleanup-batch")
def transcript_cleanup_batch_cmd(
    project: Path = typer.Option(..., "--project"),
    track: str = typer.Option(..., "--track"),
    corrections_json: str = typer.Option(
        ...,
        "--corrections-json",
        help=(
            'JSON {"words": [{"word_index": i, "text": "..."}], '
            '"phrases": [{"start_word_index": i, "end_word_index": j, "text": "..."}]}'
        ),
    ),
) -> None:
    """Batch word + phrase corrections on one track in a single undo step."""
    ws = ProjectWorkspace.open(project)
    try:
        payload = json.loads(corrections_json)
    except json.JSONDecodeError as exc:
        raise typer.BadParameter(f"--corrections-json is not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise typer.BadParameter("--corrections-json must be a JSON object")
    words = payload.get("words")
    phrases = payload.get("phrases")
    n = EditService(ws).apply_transcript_cleanup(track, words=words, phrases=phrases)
    typer.echo(f"Applied {n} correction(s).")


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
    max_duration_sec: float | None = typer.Option(
        None, "--max-duration-sec", help="Cue duration cap in seconds (default: export.captions)."
    ),
    max_chars_per_line: int | None = typer.Option(
        None, "--max-chars-per-line", help="Cue line-length cap (default: export.captions)."
    ),
    max_lines: int | None = typer.Option(
        None, "--max-lines", help="Cue line-count cap (default: export.captions)."
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    limits = _caption_limits(
        max_duration_sec=max_duration_sec,
        max_chars_per_line=max_chars_per_line,
        max_lines=max_lines,
    )
    path = TranscriptService(ws).export_subtitles("srt", limits=limits)
    typer.echo(str(path))


@transcript_app.command("export-vtt")
def transcript_export_vtt_cmd(
    project: Path = typer.Option(..., "--project"),
    max_duration_sec: float | None = typer.Option(
        None, "--max-duration-sec", help="Cue duration cap in seconds (default: export.captions)."
    ),
    max_chars_per_line: int | None = typer.Option(
        None, "--max-chars-per-line", help="Cue line-length cap (default: export.captions)."
    ),
    max_lines: int | None = typer.Option(
        None, "--max-lines", help="Cue line-count cap (default: export.captions)."
    ),
) -> None:
    ws = ProjectWorkspace.open(project)
    limits = _caption_limits(
        max_duration_sec=max_duration_sec,
        max_chars_per_line=max_chars_per_line,
        max_lines=max_lines,
    )
    path = TranscriptService(ws).export_subtitles("vtt", limits=limits)
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
        typer.echo(f"Error: {TRANSCRIPT_CONTEXT_BUSY_MESSAGE}", err=True)
        raise typer.Exit(1) from exc
    typer.echo(f"Wrote {path}")
