"""Send a context's ``sys.stdout`` / ``sys.stderr`` writes to its own sink (#1733).

A Studio runs CLI commands handed to it by other processes. Their ``typer.echo`` and
``print`` output must reach the caller, not Studio's own console, and two commands may run
at once, so the redirect cannot be a swap of the process-wide stream. ``install`` puts a
pass-through proxy in front of both streams once; ``capture`` binds sinks for the current
context, and a write made in that context goes to its sink. Any other write, including one
from a thread the command started (a new thread does not inherit the context), reaches the
original stream untouched.
"""

from __future__ import annotations

import sys
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

Sink = Callable[[str], None]

_stdout_sink: ContextVar[Sink | None] = ContextVar("stdout_sink", default=None)
_stderr_sink: ContextVar[Sink | None] = ContextVar("stderr_sink", default=None)
_install_lock = threading.Lock()


class _RoutedStream:
    def __init__(self, original: Any, sink: ContextVar[Sink | None]) -> None:
        self._original = original
        self._sink = sink

    def write(self, text: str) -> int:
        sink = self._sink.get()
        if sink is None or not isinstance(text, str):
            # click probes a stream with ``write(b"")``; a text stream must refuse it.
            return int(self._original.write(text))
        if text:
            sink(text)
        return len(text)

    def writelines(self, lines: Any) -> None:
        for line in lines:
            self.write(line)

    def flush(self) -> None:
        if self._sink.get() is None:
            self._original.flush()

    def isatty(self) -> bool:
        return False if self._sink.get() is not None else bool(self._original.isatty())

    def __getattr__(self, name: str) -> Any:
        return getattr(self._original, name)


def install() -> None:
    """Put the routing proxies in front of ``sys.stdout`` and ``sys.stderr`` (idempotent)."""
    with _install_lock:
        if not isinstance(sys.stdout, _RoutedStream):
            sys.stdout = _RoutedStream(sys.stdout, _stdout_sink)  # type: ignore[assignment]
        if not isinstance(sys.stderr, _RoutedStream):
            sys.stderr = _RoutedStream(sys.stderr, _stderr_sink)  # type: ignore[assignment]


@contextmanager
def capture(*, stdout: Sink, stderr: Sink) -> Iterator[None]:
    """Route this context's stdout and stderr writes to the given sinks."""
    install()
    out_token = _stdout_sink.set(stdout)
    err_token = _stderr_sink.set(stderr)
    try:
        yield
    finally:
        _stdout_sink.reset(out_token)
        _stderr_sink.reset(err_token)
