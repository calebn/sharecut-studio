"""Ctrl+C as cooperative cancel for a long CLI command (#1164).

``sigint_cancel`` turns the first SIGINT into a ``cancel_check`` the service polls, so the
work stops the way a GUI or MCP cancel does (``CancelledProgress``) and its atomic writes
clean up. A terminal Ctrl+C signals the whole foreground process group, so children spawned
inside the block start in their own session (``util.process.detached_children``): only the
cancel check stops them. A second Ctrl+C kills those children and then reaches the handler
that was there before, so the command quits at once and leaves no ffmpeg behind.
"""

from __future__ import annotations

import os
import signal
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from types import FrameType

import typer

from podcast_mcp.util.process import detached_children, kill_detached_children

#: Shell convention for "terminated by SIGINT" (128 + 2).
CANCELLED_EXIT_CODE = 130


_Handler = Callable[[int, FrameType | None], object] | int | signal.Handlers


def _pass_on(previous: _Handler) -> None:
    """Hand a SIGINT to the handler that was installed before ``sigint_cancel``."""
    if callable(previous):
        previous(signal.SIGINT, None)
    elif previous == signal.SIG_DFL:
        os.kill(os.getpid(), signal.SIGINT)


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
    installed = signal.getsignal(signal.SIGINT)
    previous: _Handler = installed if installed is not None else signal.SIG_DFL

    def on_sigint(_signum: int, _frame: FrameType | None) -> None:
        if not requested.is_set():
            requested.set()
            typer.echo("Cancelling. Press Ctrl+C again to quit now.", err=True)
            return
        kill_detached_children()
        signal.signal(signal.SIGINT, previous)
        _pass_on(previous)

    signal.signal(signal.SIGINT, on_sigint)
    try:
        with detached_children():
            yield requested.is_set
    finally:
        kill_detached_children()
        signal.signal(signal.SIGINT, previous)
