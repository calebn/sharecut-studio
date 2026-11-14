"""The one call the iOS shell makes into the engine, answered in a single line.

The shell is Rust and reads a C string, so ``boot_line()`` never raises: ``ok <port> <code>``
(no code on a host whose loopback is trusted) or ``error <one line>``. The traceback of a failed
start is already in ``engine.log`` (``gui/embedded.py``); an import that fails before the engine
module exists goes to stderr here.
"""

from __future__ import annotations

import sys
import traceback


def boot_line() -> str:
    try:
        from podcast_mcp.gui import embedded
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        detail = str(exc).strip().splitlines()
        return (
            f"error {type(exc).__name__}: {detail[0]}" if detail else f"error {type(exc).__name__}"
        )
    try:
        started = embedded.start()
    except embedded.EmbeddedStartError as exc:
        return f"error {exc}"
    if started.exchange_code is None:
        return f"ok {started.port}"
    return f"ok {started.port} {started.exchange_code}"
