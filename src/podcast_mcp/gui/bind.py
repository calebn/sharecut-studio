"""Exclusive loopback listen socket for the GUI sidecar.

Packaged Sharecut Studio binds ``127.0.0.1:0`` (ephemeral) so :8765 is not a
stable squat target. CLI ``podcast gui`` still defaults to 8765.
"""

from __future__ import annotations

import importlib.util
import os
import re
import secrets
import socket
import stat
import sys
from pathlib import Path
from typing import Any

from podcast_mcp.util.atomic_json import load_json_object, write_json_atomic
from podcast_mcp.util.hashing import sha256_file

BOOT_TOKEN_ENV = "PODCAST_SIDECAR_BOOT_TOKEN"
BOOT_TOKEN_HEADER = "x-sharecut-boot-token"
EPHEMERAL_ENV = "PODCAST_SIDECAR_EPHEMERAL"
LISTEN_FILE_ENV = "PODCAST_SIDECAR_LISTEN_FILE"
_EDITING_REQUEST_ENV = "PODCAST_EDITING_BIND_REQUEST"

_TRUE = frozenset({"1", "true", "yes"})


def gui_server_deps_available() -> bool:
    """True when the GUI extra (uvicorn) is importable."""
    return importlib.util.find_spec("uvicorn") is not None


def ephemeral_requested() -> bool:
    return os.environ.get(EPHEMERAL_ENV, "").strip().lower() in _TRUE


def resolved_bind_port(port: int) -> int:
    """Return ``0`` when the packaged sidecar asks for an ephemeral port."""
    if ephemeral_requested():
        return 0
    return port


def boot_token_accepted(provided: str | None) -> bool:
    """When ``PODCAST_SIDECAR_BOOT_TOKEN`` is set, require a matching header."""
    expected = os.environ.get(BOOT_TOKEN_ENV, "").strip()
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
    try:
        sock.bind((host, port))
        sock.listen(2048)
    except OSError:
        sock.close()
        raise
    return sock


def write_listen_file(path: Path, *, port: int, pid: int) -> None:
    """Atomically write ``{port, pid}`` with mode ``0600``."""
    write_json_atomic(
        path,
        {"port": int(port), "pid": int(pid)},
        mode=stat.S_IRUSR | stat.S_IWUSR,
        compact=True,
    )


def _editing_identity(app: Any, host: str, port: int) -> tuple[Path, dict[str, Any]] | None:
    if _EDITING_REQUEST_ENV not in os.environ:
        return None
    try:
        request_path = Path(os.environ[_EDITING_REQUEST_ENV])
        if not os.environ[_EDITING_REQUEST_ENV].strip():
            raise ValueError("empty request path")
        request = load_json_object(request_path)
        if request is None or set(request) != {
            "version",
            "protocolHash",
            "host",
            "port",
            "expected",
        }:
            raise ValueError("invalid request fields")
        expected = request["expected"]
        keys = {
            "cwd",
            "executable",
            "module",
            "moduleName",
            "sourceHash",
            "productionDist",
            "shareRegistry",
        }
        if not isinstance(expected, dict) or set(expected) != keys:
            raise ValueError("invalid expected fields")
        if any(not isinstance(value, str) or not value.strip() for value in expected.values()):
            raise ValueError("invalid expected identity")
        if (
            type(request["version"]) is not int
            or request["version"] != 1
            or type(request["port"]) is not int
            or not 1 <= request["port"] <= 65535
            or request["host"] != "127.0.0.1"
            or request["host"] != host
            or request["port"] != port
            or not isinstance(request["protocolHash"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", request["protocolHash"])
            or not re.fullmatch(r"[a-f0-9]{64}", expected["sourceHash"])
        ):
            raise ValueError("invalid protocol or lease")
        if sys.platform != "linux":
            raise ValueError("native listener identity requires Linux")
        if any(name in os.environ for name in (BOOT_TOKEN_ENV, EPHEMERAL_ENV, LISTEN_FILE_ENV)):
            raise ValueError("conflicting sidecar configuration")
        module = app.state.editing_factory_module
        if (
            module.__name__ != "podcast_mcp.gui.server"
            or sys.modules.get(module.__name__) is not module
        ):
            raise ValueError("unregistered factory module")
        module_path = Path(module.__file__).resolve(strict=True)
        from podcast_mcp.edits.share_registry import default_share_registry_db_path

        actual = {
            "cwd": str(Path.cwd().resolve()),
            "executable": str(Path(sys.executable).resolve(strict=True)),
            "module": str(module_path),
            "moduleName": module.__name__,
            "sourceHash": sha256_file(module_path),
            "productionDist": str(app.state.editing_static_root.resolve(strict=True)),
            "shareRegistry": str(default_share_registry_db_path()),
        }
        if actual != expected:
            raise ValueError("actual factory identity differs from admitted backend")
        receipt_path = request_path.parent / "live.json"
        if receipt_path.exists():
            raise ValueError("live receipt already exists")
        return receipt_path, {
            "version": 1,
            "protocolHash": request["protocolHash"],
            "actual": actual,
        }
    except (AttributeError, OSError, TypeError, ValueError) as exc:
        raise ValueError("Editing backend bind identity rejected") from exc


def run_gui_server(
    app: Any,
    *,
    host: str,
    port: int,
    log_level: str = "info",
) -> None:
    """Bind exclusively, optionally write the listen file, then run uvicorn."""
    import uvicorn

    editing = _editing_identity(app, host, port)
    bind_port = resolved_bind_port(port)
    sock = exclusive_listen_socket(host, bind_port)
    listen_written: Path | None = None
    editing_written: tuple[Path, int, int] | None = None
    try:
        bound_host, bound_port = sock.getsockname()[:2]
        bound_port = int(bound_port)
        if editing is not None:
            dest, receipt = editing
            write_json_atomic(
                dest,
                {**receipt, "host": bound_host, "port": bound_port, "pid": os.getpid()},
                mode=stat.S_IRUSR | stat.S_IWUSR,
                compact=True,
            )
            published = dest.stat()
            editing_written = (dest, published.st_dev, published.st_ino)
        listen = os.environ.get(LISTEN_FILE_ENV, "").strip()
        if listen:
            dest = Path(listen)
            write_listen_file(dest, port=bound_port, pid=os.getpid())
            listen_written = dest
        config = uvicorn.Config(
            app,
            log_level=log_level,
            ws_per_message_deflate=True,
        )
        uvicorn.Server(config).run(sockets=[sock])
    finally:
        try:
            if editing_written is not None:
                dest, device, inode = editing_written
                try:
                    current = dest.stat()
                except FileNotFoundError:
                    pass
                else:
                    if (current.st_dev, current.st_ino) == (device, inode):
                        dest.unlink()
            if listen_written is not None:
                listen_written.unlink(missing_ok=True)
        finally:
            sock.close()
