from __future__ import annotations

import getpass
from collections.abc import Callable
from contextlib import AbstractContextManager
from typing import Any, TypeVar

import typer

from podcast_mcp.edits.audio_check_override import audio_check_override
from podcast_mcp.edits.cut_speech import CutSpeechConfirmation

T = TypeVar("T")


def _pending(result: object) -> dict[str, Any] | None:
    if isinstance(result, CutSpeechConfirmation):
        return result.model_dump(mode="json")
    if isinstance(result, dict):
        return result.get("needs_confirmation")
    return None


def require_cut_applied(run: Callable[[], T], *, what: str = "this cut") -> T:
    """Run ``run``; a held result prints its message and exits, naming ``what`` it would apply."""
    result = run()
    pending = _pending(result)
    if pending is None:
        return result
    typer.echo(str(pending["message"]), err=True)
    typer.echo(
        f"Nothing changed. To apply {what} as is, repeat the command with --override-audio-checks.",
        err=True,
    )
    raise typer.Exit(1)


def override_audio_checks_option() -> Any:
    return typer.Option(
        False,
        "--override-audio-checks",
        help=(
            "Apply even if the automatic audio-quality and cut-position checks would hold "
            "this edit (a mid-word or harsh cut you want anyway). Recorded in the edit log."
        ),
    )


def cli_actor() -> str:
    try:
        return f"cli:{getpass.getuser()}"
    except (KeyError, OSError):
        return "cli:unknown"


def cli_override(enabled: bool) -> AbstractContextManager[Any]:
    return audio_check_override(cli_actor(), "cli", enabled=enabled)
