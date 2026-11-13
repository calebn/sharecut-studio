from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from host_session_helpers import UNTRUSTED, exchange, untrusted_app
from podcast_mcp.gui.server import create_app
from podcast_mcp.services.session_sync.authz import authorize_host
from podcast_mcp.util.host_platform import IOS, LINUX, MACOS, UNKNOWN

TOKEN = "s3cret-token"
LOOPBACK = ("127.0.0.1", 50000)


@pytest.fixture
def session_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", TOKEN)


@pytest.mark.parametrize("strict", [False, True])
def test_a_loopback_peer_needs_a_session_where_loopback_is_not_trusted(
    host, monkeypatch: pytest.MonkeyPatch, session_token, strict: bool
) -> None:
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict" if strict else "")
    host(UNTRUSTED)
    refused = authorize_host(peer_host="127.0.0.1")
    assert (refused.allowed, refused.reason) == (False, "this host requires an owner session")
    shared_token = authorize_host(peer_host="127.0.0.1", token=TOKEN)
    assert (shared_token.allowed, shared_token.reason) == (
        False,
        "this host requires an owner session",
    )
    session = authorize_host(peer_host="127.0.0.1", session=True)
    assert (session.allowed, session.reason) == (True, "session")


@pytest.mark.parametrize("row", [MACOS, LINUX])
def test_a_session_does_not_stand_in_for_the_token_where_loopback_is_trusted(
    host, monkeypatch: pytest.MonkeyPatch, session_token, row
) -> None:
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    host(row)
    decision = authorize_host(peer_host="203.0.113.9", session=True)
    assert (decision.allowed, decision.reason) == (
        False,
        "remote client requires PODCAST_SESSION_TOKEN",
    )


@pytest.mark.parametrize("row", [IOS, UNKNOWN])
def test_an_owner_route_needs_the_session_cookie_where_loopback_is_not_trusted(
    host, session_token, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, row
) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    host(row)
    app = untrusted_app()
    client = TestClient(app, client=LOOPBACK)
    refused = client.get("/api/bootstrap/status")
    assert (refused.status_code, refused.headers["X-Sharecut-Error-Code"]) == (403, "authz_denied")
    header_token = client.get("/api/bootstrap/status", headers={"X-Podcast-Token": TOKEN})
    assert header_token.status_code == 403
    exchange(client, app)
    accepted = client.get("/api/bootstrap/status")
    assert (accepted.status_code, accepted.json()["host"]["name"]) == (200, row.name)


def test_a_host_without_a_configured_token_refuses_everyone_where_loopback_is_not_trusted(
    host, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PODCAST_SESSION_TOKEN", raising=False)
    host(IOS)
    assert authorize_host(peer_host="127.0.0.1", token="").allowed is False
    assert authorize_host(peer_host="127.0.0.1", token="anything").allowed is False


@pytest.mark.parametrize("row", [MACOS, LINUX])
def test_a_desktop_loopback_peer_is_still_admitted_without_a_token(host, row) -> None:
    host(row)
    assert authorize_host(peer_host="127.0.0.1").allowed is True


def test_a_desktop_app_mounts_host_mcp_and_serves_owner_routes_from_loopback(
    host, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    host(MACOS)
    app = create_app()
    assert app.state.host_mcp_session_manager is not None
    assert TestClient(app, client=LOOPBACK).get("/api/bootstrap/status").status_code == 200


def test_building_an_app_on_ios_does_not_import_the_tool_server() -> None:
    script = (
        "import sys\n"
        "from podcast_mcp.util import host_platform\n"
        "from podcast_mcp.gui.server import create_app\n"
        "with host_platform.using(host_platform.IOS):\n"
        "    create_app()\n"
        "print('podcast_mcp.mcp.server' in sys.modules, 'podcast_mcp.gui.host_mcp' in sys.modules)\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, check=True
    )
    assert done.stdout.strip() == "False False"
