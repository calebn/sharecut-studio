"""Ctrl+C as cooperative cancel for a long CLI command (#1164).

``sigint_cancel`` turns the first SIGINT into a ``cancel_check`` the service polls, so the
work stops the way a GUI or MCP cancel does (``CancelledProgress``) and its atomic writes
clean up. A terminal Ctrl+C signals the whole foreground process group, so children spawned
inside the block start in their own session (``util.process.detached_children``): only the
cancel check stops them. A second Ctrl+C, or a signal that ends the command (SIGTERM,
SIGHUP, SIGQUIT), kills those children and then reaches the handler that was there before,
so the command quits at once and leaves no ffmpeg behind.
"""

from __future__ import annotations

import signal
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from types import FrameType

import typer

from podcast_mcp.util.process import detached_children, kill_detached_children

#: Shell convention for "terminated by SIGINT" (128 + 2).
CANCELLED_EXIT_CODE = 130

#: Signals that end the command at once: terminal closed (SIGHUP), ``kill`` (SIGTERM) and
#: Ctrl+\ (SIGQUIT). Their default action skips ``finally``, and the detached children are
#: outside the terminal's process group, so the handler kills them before passing it on.
FATAL_SIGNALS: tuple[signal.Signals, ...] = tuple(
    getattr(signal, name) for name in ("SIGTERM", "SIGHUP", "SIGQUIT") if hasattr(signal, name)
)


_Handler = Callable[[int, FrameType | None], object] | int | signal.Handlers


def _handler_before(signum: signal.Signals) -> _Handler:
    installed = signal.getsignal(signum)
    return installed if installed is not None else signal.SIG_DFL


def _pass_on(signum: int, previous: _Handler) -> None:
    """Hand ``signum`` to ``previous``, the handler that was there before ``sigint_cancel``.

    The caller restores ``previous`` first, so a default action (end the process by this
    signal) runs as if the block had never been entered.
    """
    if callable(previous):
        previous(signum, None)
    elif previous == signal.SIG_DFL:
        signal.raise_signal(signum)


@contextmanager
def sigint_cancel() -> Iterator[Callable[[], bool]]:
    """Yield a ``cancel_check`` that turns true after the first SIGINT inside the block.

    A second SIGINT, or SIGTERM / SIGHUP / SIGQUIT, kills the detached children, restores
    that signal's earlier handler and passes the signal on, so the exit status is the usual
    one for that signal. A signal ignored on entry (``nohup``) stays ignored. Every handler
    is restored on exit. Signal handlers can only be installed from the main thread;
    elsewhere the check never fires and the signals keep their usual meaning.
    """
    if threading.current_thread() is not threading.main_thread():
        yield lambda: False
        return
    requested = threading.Event()
    previous: dict[int, _Handler] = {
        signum: _handler_before(signum) for signum in (signal.SIGINT, *FATAL_SIGNALS)
    }

    def end_now(signum: int, _frame: FrameType | None) -> None:
        requested.set()
        kill_detached_children()
        signal.signal(signum, previous[signum])
        _pass_on(signum, previous[signum])

    def on_sigint(signum: int, frame: FrameType | None) -> None:
        if not requested.is_set():
            requested.set()
            typer.echo("Cancelling. Press Ctrl+C again to quit now.", err=True)
            return
        end_now(signum, frame)

    for signum, handler in previous.items():
        if handler != signal.SIG_IGN:
            signal.signal(signum, on_sigint if signum == signal.SIGINT else end_now)
    try:
        with detached_children():
            yield requested.is_set
    finally:
        kill_detached_children()
        for signum, handler in previous.items():
            signal.signal(signum, handler)
