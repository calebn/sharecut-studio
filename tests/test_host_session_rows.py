"""Every row whose loopback is not trusted gets the same owner session rule (#3810).

The ``iOS`` row and the fail-closed ``UNKNOWN`` row differ in name only, so each surface the
rule gates is held on both. A pure authorization and HTTP test may select a row directly.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from host_session_helpers import (
    LISTEN_PORT,
    LOOPBACK_PEER,
    OWNER_TOKEN,
    SELF_ORIGIN,
    exchange,
    untrusted_app,
)
from podcast_mcp.gui.routes import handoff
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import studio_host_path
from podcast_mcp.util.host_platform import IOS, UNKNOWN
from podcast_mcp.util.host_session_wire import EXCHANGE_PATH, SESSION_COOKIE

STATUS = "/api/bootstrap/status"
ROWS = pytest.mark.parametrize("row", [IOS, UNKNOWN], ids=["ios", "unknown"])


@pytest.fixture(autouse=True)
def cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", OWNER_TOKEN)


@ROWS
def test_the_exchange_route_is_registered_and_signs_the_owner_in(host, row) -> None:
    host(row)
    app = untrusted_app()
    client = TestClient(app, client=LOOPBACK_PEER)

    assert app.state.host_sessions is not None
    assert client.get(EXCHANGE_PATH).status_code == 403
    exchange(client, app)
    assert client.get(STATUS).status_code == 200


@ROWS
def test_the_header_token_is_refused_and_only_the_cookie_is_accepted(host, row) -> None:
    host(row)
    app = untrusted_app()
    client = TestClient(app, client=LOOPBACK_PEER)

    assert client.get(STATUS, headers={"X-Podcast-Token": OWNER_TOKEN}).status_code == 403
    assert client.get(f"{STATUS}?token={OWNER_TOKEN}").status_code == 403
    exchange(client, app)
    assert client.cookies.get(SESSION_COOKIE)
    assert client.get(STATUS).status_code == 200


@ROWS
@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_the_api_documentation_is_not_served(host, row, path: str) -> None:
    host(row)

    assert TestClient(untrusted_app(), client=LOOPBACK_PEER).get(path).status_code == 404


@ROWS
def test_the_handoff_routes_are_not_mounted_and_nothing_is_announced(
    host, row, minimal_project: Path
) -> None:
    host(row)
    project = load_project(minimal_project)
    project.meta.name = "Quarterly Secrets Episode"
    save_project(project, minimal_project)
    app = untrusted_app(served_project=minimal_project)
    client = TestClient(app, client=LOOPBACK_PEER)

    assert client.get("/api/handoff/ping").status_code == 404
    handoff.listening(app, port=LISTEN_PORT, host="127.0.0.1")
    assert not studio_host_path(minimal_project).exists()
    handoff.stopped(app)


@ROWS
def test_the_host_tool_server_is_not_mounted(host, row) -> None:
    host(row)
    app = untrusted_app()

    assert app.state.host_mcp_session_manager is None
    assert TestClient(app, client=LOOPBACK_PEER).post("/mcp", json={}).status_code == 404


@ROWS
def test_only_the_engines_own_origin_is_admitted(host, row) -> None:
    host(row)
    app = untrusted_app()
    client = TestClient(app, client=LOOPBACK_PEER)
    exchange(client, app)

    assert client.get(STATUS, headers={"Origin": SELF_ORIGIN}).status_code == 200
    for foreign in ("http://127.0.0.1:5173", f"http://localhost:{LISTEN_PORT}", "null"):
        assert client.get(STATUS, headers={"Origin": foreign}).status_code == 403
    assert (
        "access-control-allow-origin"
        not in client.get(STATUS, headers={"Origin": "http://127.0.0.1:5173"}).headers
    )


@ROWS
def test_a_cross_site_request_with_the_cookie_is_refused(host, row) -> None:
    host(row)
    app = untrusted_app()
    client = TestClient(app, client=LOOPBACK_PEER)
    exchange(client, app)

    assert client.get(STATUS, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert client.get(STATUS, headers={"Sec-Fetch-Site": "same-origin"}).status_code == 200


@ROWS
def test_the_policy_names_the_engines_own_port_and_sends_no_referrer(host, row) -> None:
    host(row)
    response = TestClient(untrusted_app(), client=LOOPBACK_PEER).get("/")

    assert response.headers["referrer-policy"] == "no-referrer"
    assert "connect-src 'self' ws://127.0.0.1:49321" in response.headers["content-security-policy"]
