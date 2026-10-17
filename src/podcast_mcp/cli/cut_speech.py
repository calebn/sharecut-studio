from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeVar

import typer

from podcast_mcp.edits.cut_speech import CutSpeechConfirmation

T = TypeVar("T")


def _pending(result: object) -> dict[str, Any] | None:
    if isinstance(result, CutSpeechConfirmation):
        return result.model_dump(mode="json")
    if isinstance(result, dict):
        return result.get("needs_confirmation")
    return None


def require_cut_applied(run: Callable[[], T]) -> T:
    result = run()
    pending = _pending(result)
    if pending is None:
        return result
    typer.echo(str(pending["message"]), err=True)
    typer.echo("Nothing changed. Review and approve this cut in Sharecut Studio.", err=True)
    raise typer.Exit(1)
