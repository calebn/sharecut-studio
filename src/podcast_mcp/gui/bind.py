"""Exclusive loopback listen socket for the GUI sidecar.

Packaged ShareCut Studio binds ``127.0.0.1:0`` (ephemeral) so :8765 is not a
stable squat target. CLI ``podcast gui`` still defaults to 8765.
"""

from __future__ import annotations

import importlib.util
import os
import secrets
import socket
import stat
import sys
from pathlib import Path
from typing import Any

from podcast_mcp import settings
from podcast_mcp.util.atomic_json import write_json_atomic

BOOT_TOKEN_ENV = "PODCAST_SIDECAR_BOOT_TOKEN"
BOOT_TOKEN_HEADER = "x-sharecut-boot-token"
EPHEMERAL_ENV = "PODCAST_SIDECAR_EPHEMERAL"
LISTEN_FILE_ENV = "PODCAST_SIDECAR_LISTEN_FILE"

_TRUE = frozenset({"1", "true", "yes"})


def gui_server_deps_available() -> bool:
    """True when the GUI extra (uvicorn) is importable."""
    return importlib.util.find_spec("uvicorn") is not None


def ephemeral_requested() -> bool:
    return settings.text(EPHEMERAL_ENV).lower() in _TRUE


def resolved_bind_port(port: int) -> int:
    """Return ``0`` when the packaged sidecar asks for an ephemeral port."""
    if ephemeral_requested():
        return 0
    return port


def boot_token_accepted(provided: str | None) -> bool:
    """When ``PODCAST_SIDECAR_BOOT_TOKEN`` is set, require a matching header."""
    expected = settings.text(BOOT_TOKEN_ENV)
    if not expected:
        return True
    got = (provided or "").strip()
    try:
        return secrets.compare_digest(got, expected)
    except (TypeError, ValueError):
        return False


def exclusive_listen_socket(host: str, port: int) -> socket.socket:
    """Bind ``(host, port)`` without ``SO_REUSEADDR`` (Windows exclusive)."""
    family = socket.AF_INET6 if ":" in host.strip("[]") else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    if sys.platform == "win32":
        exclusive = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if exclusive is None:
            sock.close()
            raise OSError("SO_EXCLUSIVEADDRUSE is required for exclusive GUI bind")
        sock.setsockopt(socket.SOL_SOCKET, exclusive, 1)
    else:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
    sock.bind((host, port))
    sock.listen(2048)
    return sock


def write_listen_file(path: Path, *, port: int, pid: int) -> None:
    """Atomically write ``{port, pid}`` with mode ``0600``."""
    write_json_atomic(
        path,
        {"port": int(port), "pid": int(pid)},
        mode=stat.S_IRUSR | stat.S_IWUSR,
        compact=True,
    )


def run_gui_server(
    app: Any,
    *,
    host: str,
    port: int,
    log_level: str = "info",
) -> None:
    """Bind exclusively, optionally write the listen file, then run uvicorn."""
    import uvicorn

    bind_port = resolved_bind_port(port)
    sock = exclusive_listen_socket(host, bind_port)
    listen_written: Path | None = None
    try:
        bound_port = int(sock.getsockname()[1])
        state = getattr(app, "state", None)
        if state is not None:
            state.listen_port = bound_port
        listen = settings.text(LISTEN_FILE_ENV)
        if listen:
            dest = Path(listen)
            write_listen_file(dest, port=bound_port, pid=os.getpid())
            listen_written = dest
        config = uvicorn.Config(
            app,
            log_level=log_level,
            ws_per_message_deflate=True,
        )
        server = uvicorn.Server(config)
        _cancel_handed_off_commands_on_exit(server, app)
        server.run(sockets=[sock])
    finally:
        if listen_written is not None:
            listen_written.unlink(missing_ok=True)
        sock.close()


def _cancel_handed_off_commands_on_exit(server: Any, app: Any) -> None:
    """Stop CLI commands handed to this Studio as soon as it is asked to quit.

    uvicorn runs the app's shutdown only after every open connection has closed, and a
    handed-off command's stream is such a connection, so the lifespan hook alone would wait
    for the command to finish.
    """
    state = getattr(app, "state", None)
    if getattr(state, "studio_host", None) is None:
        return
    from podcast_mcp.gui.routes import handoff

    original = server.handle_exit

    def handle_exit(sig: int, frame: Any) -> None:
        handoff.stopped(app)
        original(sig, frame)

    server.handle_exit = handle_exit
