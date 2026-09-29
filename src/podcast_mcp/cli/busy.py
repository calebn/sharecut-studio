"""Root command group: one choke point for CLI errors that would otherwise be an
unhandled-exception traceback (#488, #773).

Two families land here, both printed as ``Error: <message>`` on stderr with exit 1:

- a ``filelock.Timeout`` (``ProjectBusyError`` / ``RenderBusyError`` or a raw one) from a
  busy project/render lock (#488);
- a domain guard error — ``ValueError`` / ``RuntimeError``, the base classes most guard
  exceptions across ``services`` / ``edits`` subclass (``TranscriptRefineRequiredError``,
  ``AlignAcceptRequiredError``, ``HistoryRerenderError``, ``resolve_track``'s plain
  ``ValueError``, ...) (#773).

Set ``PODCAST_DEBUG=1`` to get the original traceback instead of either message — useful
for a real bug (``TypeError``, a bad unpack, ``NotImplementedError``) that happens to
subclass one of the two caught types, or to see exactly where a busy lock came from.

``typer.Exit`` / ``typer.Abort`` subclass ``RuntimeError`` in the installed typer version,
so they pass through untouched: a command that already chose its own exit code (e.g.
``bootstrap --component bogus`` -> 2, or a Click usage error -> 2) is unaffected. A command
with its own narrower ``try/except`` (``undo``, ``redo``, ``history goto`` for move-advice
text; ``transcript context set`` for a busy context lock) is also unaffected — its except
clause runs first and this group never sees the exception.
"""

from __future__ import annotations

import os
from typing import Any

import typer
from filelock import Timeout
from typer.core import TyperGroup

from podcast_mcp.util.project_state import busy_message

_DEBUG_ENV_VAR = "PODCAST_DEBUG"
_DEBUG_HINT = f"(set {_DEBUG_ENV_VAR}=1 for the traceback)"

# typer's own control-flow signals; both subclass RuntimeError in the installed typer
# version, so they must be excluded or every explicit exit code would collapse to 1.
_PASSTHROUGH: tuple[type[BaseException], ...] = (typer.Exit, typer.Abort)

_DOMAIN_ERRORS: tuple[type[BaseException], ...] = (ValueError, RuntimeError)


def _debug_enabled() -> bool:
    return os.environ.get(_DEBUG_ENV_VAR, "").strip().lower() not in ("", "0", "false")


class BusyErrorGroup(TyperGroup):
    """See module docstring: the CLI's one choke point for a busy lock or domain error."""

    def invoke(self, ctx: Any) -> Any:
        try:
            return super().invoke(ctx)
        except _PASSTHROUGH:
            raise
        except Timeout as exc:
            if _debug_enabled():
                raise
            typer.echo(f"Error: {busy_message(exc)} {_DEBUG_HINT}", err=True)
            raise typer.Exit(1) from exc
        except _DOMAIN_ERRORS as exc:
            if _debug_enabled():
                raise
            typer.echo(f"Error: {exc} {_DEBUG_HINT}", err=True)
            raise typer.Exit(1) from exc
