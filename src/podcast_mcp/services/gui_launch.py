from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from dataclasses import asdict, dataclass
from pathlib import Path

from podcast_mcp.util.process import DEVNULL, popen


def resolve_gui_static_root() -> Path:
    """Defer gui import so ``services.__init__`` can finish loading."""
    from podcast_mcp.gui.static_assets import resolve_gui_static_root as impl

    return impl()


@dataclass(frozen=True)
class GuiLaunchResult:
    ok: bool
    url: str
    host: str
    port: int
    project_path: str
    already_running: bool
    opened_browser: bool
    pid: int | None = None
    static_built: bool = True
    error: str | None = None
    hint: str | None = None

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2)


def viewer_url(
    host: str,
    port: int,
    project_path: Path,
    *,
    session_token: str | None = None,
) -> str:
    from urllib.parse import urlencode

    q = {"project": str(project_path.resolve())}
    if session_token:
        q["session_token"] = session_token
    return f"http://{host}:{port}/?{urlencode(q)}"


def is_viewer_up(host: str, port: int, *, timeout_sec: float = 0.4) -> bool:
    try:
        from podcast_mcp.gui.bind import BOOT_TOKEN_ENV, BOOT_TOKEN_HEADER

        # Constructed from host/port only; never file: or attacker-controlled schemes.
        health_url = f"http://{host}:{port}/api/health"
        req = urllib.request.Request(health_url, method="GET")
        token = os.environ.get(BOOT_TOKEN_ENV, "").strip()
        if token:
            req.add_header(BOOT_TOKEN_HEADER, token)
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:  # nosec B310
            if resp.status != 200:
                return False
            body = json.loads(resp.read().decode("utf-8"))
            return bool(body.get("ok"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return False


def _port_in_use(host: str, port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        return sock.connect_ex((host, port)) == 0


def ensure_viewer(
    project_path: str | Path,
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
    open_browser: bool = True,
    wait_sec: float = 8.0,
) -> GuiLaunchResult:
    """Start the read-only DAW viewer in the background if it is not already up."""
    path = Path(project_path).expanduser().resolve()
    if not path.is_file():
        return GuiLaunchResult(
            ok=False,
            url="",
            host=host,
            port=port,
            project_path=str(path),
            already_running=False,
            opened_browser=False,
            error=f"Project not found: {path}",
        )

    from podcast_mcp.gui.routes.deps import ensure_non_loopback_session_auth

    session_token = ensure_non_loopback_session_auth(host)
    if session_token is not None:
        import logging

        logging.getLogger(__name__).warning(
            "GUI bound to %s - PODCAST_SESSION_AUTHZ=strict is enabled; "
            "open the printed URL (includes session_token).",
            host,
        )

    url = viewer_url(host, port, path, session_token=session_token)
    dist = resolve_gui_static_root()
    static_built = dist.is_dir() and (dist / "index.html").is_file()

    if is_viewer_up(host, port):
        opened = False
        if open_browser:
            opened = bool(webbrowser.open(url))
        return GuiLaunchResult(
            ok=True,
            url=url,
            host=host,
            port=port,
            project_path=str(path),
            already_running=True,
            opened_browser=opened,
            static_built=static_built,
            hint=None
            if static_built
            else "API is up but gui/web dist is missing - run: cd gui/web && npm install && npm run build",
        )

    if _port_in_use(host, port):
        return GuiLaunchResult(
            ok=False,
            url=url,
            host=host,
            port=port,
            project_path=str(path),
            already_running=False,
            opened_browser=False,
            static_built=static_built,
            error=f"Port {port} is in use but /api/health did not respond",
            hint="Pass a different port, or stop the other process",
        )

    from podcast_mcp.gui.bind import gui_server_deps_available

    if not gui_server_deps_available():
        return GuiLaunchResult(
            ok=False,
            url=url,
            host=host,
            port=port,
            project_path=str(path),
            already_running=False,
            opened_browser=False,
            static_built=static_built,
            error="GUI dependencies missing",
            hint="Install with: uv sync --extra gui",
        )

    proc = popen(
        [
            sys.executable,
            "-m",
            "podcast_mcp.gui.serve",
            "--host",
            host,
            "--port",
            str(port),
            "--project",
            str(path),
        ],
        stdout=DEVNULL,
        stderr=DEVNULL,
        start_new_session=True,
    )

    deadline = time.monotonic() + wait_sec
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return GuiLaunchResult(
                ok=False,
                url=url,
                host=host,
                port=port,
                project_path=str(path),
                already_running=False,
                opened_browser=False,
                pid=proc.pid,
                static_built=static_built,
                error="Viewer process exited before becoming healthy",
                hint=None
                if static_built
                else "Build the UI: cd gui/web && npm install && npm run build",
            )
        if is_viewer_up(host, port):
            opened = False
            if open_browser:
                opened = bool(webbrowser.open(url))
            hint = None
            if not static_built:
                hint = (
                    "API started but gui/web dist is missing - "
                    "run: cd gui/web && npm install && npm run build"
                )
            return GuiLaunchResult(
                ok=True,
                url=url,
                host=host,
                port=port,
                project_path=str(path),
                already_running=False,
                opened_browser=opened,
                pid=proc.pid,
                static_built=static_built,
                hint=hint,
            )
        time.sleep(0.15)

    return GuiLaunchResult(
        ok=False,
        url=url,
        host=host,
        port=port,
        project_path=str(path),
        already_running=False,
        opened_browser=False,
        pid=proc.pid,
        static_built=static_built,
        error=f"Timed out waiting for viewer on {host}:{port}",
        hint="Check that the gui extra is installed and the port is free",
    )
