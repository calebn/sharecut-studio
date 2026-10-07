"""CLI side of the speech guard: prompt before a ripple cuts another track's speech."""

from __future__ import annotations

import sys
from collections.abc import Callable
from typing import Any, TypeVar

import typer

from podcast_mcp.edits.cut_speech import CUT_ANYWAY_LABEL, CutSpeechConfirmation

T = TypeVar("T")

YES_HELP = "Cut another track's speech without asking (the ripple's 'Cut anyway')"


def _pending(result: object) -> dict[str, Any] | None:
    if isinstance(result, CutSpeechConfirmation):
        return result.model_dump(mode="json")
    if isinstance(result, dict):
        return result.get("needs_confirmation")
    return None


def with_cut_speech_confirmation(run: Callable[[bool], T], *, yes: bool) -> T:
    """``run(confirm_cut_speech)``; ask at a terminal, else require ``--yes``.

    Nothing changes unless the person confirms, so a declined or non-interactive run
    exits 1 with the speech it would cut.
    """
    result = run(yes)
    pending = _pending(result)
    if pending is None:
        return result
    message = str(pending["message"])
    if sys.stdin.isatty() and typer.confirm(f"{message}\n{CUT_ANYWAY_LABEL}?", default=False):
        return run(True)
    typer.echo(message, err=True)
    typer.echo("Nothing changed. Run again with --yes to cut anyway.", err=True)
    raise typer.Exit(1)
