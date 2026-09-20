from __future__ import annotations

import functools
import sys
from collections.abc import Callable
from typing import TypeVar

F = TypeVar("F", bound=Callable[..., object])


def timed_command(label: str) -> Callable[[F], F]:
    """Legacy elapsed wrapper — prefer the CLI progress choke-point wrap.

    Kept for call sites that already decorate commands; opens a named phase on
    the bound reporter when present so it is not a parallel progress path.
    """

    def decorator(fn: F) -> F:
        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            from podcast_mcp.util.progress import current_progress, current_progress_task_id

            progress = current_progress()
            task_id = current_progress_task_id() or "cli"
            progress.message(task_id, f"Running {label}…")
            try:
                return fn(*args, **kwargs)
            finally:
                # Elapsed finish line only when stderr is a TTY and no Rich bar.
                if sys.stderr.isatty():
                    sys.stderr.write(f"Finished {label}\n")
                    sys.stderr.flush()

        return wrapper  # type: ignore[return-value]

    return decorator
