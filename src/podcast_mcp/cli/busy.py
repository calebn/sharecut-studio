"""Root command group that turns an escaping busy-lock timeout into a clean CLI error (#488)."""

from __future__ import annotations

from typing import Any

import typer
from filelock import Timeout
from typer.core import TyperGroup

from podcast_mcp.util.project_state import busy_message


class BusyErrorGroup(TyperGroup):
    """One choke point for a ``filelock.Timeout`` (``ProjectBusyError`` / ``RenderBusyError``
    or a raw one) that escapes a command, instead of a try/except in every command.

    A handful of leaf commands (``undo``, ``redo``, ``history goto``) already catch their
    own narrower errors for move-specific advice text; none of them catch a lock timeout,
    so it reaches this group's ``invoke`` and gets the same treatment everywhere: print
    ``Error: <message>`` to stderr and exit 1, instead of an unhandled-exception traceback.
    """

    def invoke(self, ctx: Any) -> Any:
        try:
            return super().invoke(ctx)
        except Timeout as exc:
            typer.echo(f"Error: {busy_message(exc)}", err=True)
            raise typer.Exit(1) from exc
