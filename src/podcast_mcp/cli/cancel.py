"""Ctrl+C as cooperative cancel for a long CLI command (#1164).

``sigint_cancel`` turns the first SIGINT into a ``cancel_check`` the service polls, so the
work stops the way a GUI or MCP cancel does (``CancelledProgress``) and its atomic writes
clean up. A second Ctrl+C is not swallowed: it reaches the handler that was there before.
"""

from __future__ import annotations

import signal
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager

import typer

#: Shell convention for "terminated by SIGINT" (128 + 2).
CANCELLED_EXIT_CODE = 130


@contextmanager
def sigint_cancel() -> Iterator[Callable[[], bool]]:
    """Yield a ``cancel_check`` that turns true after the first SIGINT inside the block.

    Signal handlers can only be installed from the main thread; elsewhere the check never
    fires and Ctrl+C keeps its usual meaning.
    """
    if threading.current_thread() is not threading.main_thread():
        yield lambda: False
        return
    requested = threading.Event()
    previous = signal.getsignal(signal.SIGINT)
    restore = previous if previous is not None else signal.SIG_DFL

    def on_sigint(_signum: int, _frame: object) -> None:
        requested.set()
        signal.signal(signal.SIGINT, restore)
        typer.echo("Cancelling. Press Ctrl+C again to quit now.", err=True)

    signal.signal(signal.SIGINT, on_sigint)
    try:
        yield requested.is_set
    finally:
        signal.signal(signal.SIGINT, restore)
