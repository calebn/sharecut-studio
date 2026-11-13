"""Build the app and the requests of a host whose loopback is not trusted (#3810).

The row is the machine's own with ``loopback_is_trusted`` off, so a test on any desktop holds
the same way once the iOS row or a stricter fallback row is in the table.
"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from podcast_mcp.gui.server import create_app
from podcast_mcp.util import host_platform
from podcast_mcp.util.host_session_wire import SESSION_COOKIE

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"

UNTRUSTED = replace(host_platform.current(), loopback_is_trusted=False)
LOOPBACK_PEER = ("127.0.0.1", 50000)
LISTEN_PORT = 49321
SELF_ORIGIN = f"http://127.0.0.1:{LISTEN_PORT}"
OWNER_TOKEN = "shared-owner-token"


def untrusted_app(*, static_dir: Path | None = None, served_project: Path | None = None) -> FastAPI:
    """An app built on the untrusted row, as if uvicorn had bound ``LISTEN_PORT``."""
    app = create_app(static_dir=static_dir, served_project=served_project)
    app.state.listen_port = LISTEN_PORT
    return app


def exchange(client: TestClient, app: FastAPI) -> None:
    """Sign *client* in the way the web view does: a fresh code, one visit to the exchange route."""
    sys.path.insert(0, str(SCRIPTS))
    from export_bootstrap_unsupported import sign_in

    sign_in(client, app)
    assert client.cookies.get(SESSION_COOKIE)
