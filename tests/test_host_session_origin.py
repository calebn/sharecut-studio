"""A host whose loopback is not trusted answers only the engine's own origin."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from host_session_helpers import (
    LISTEN_PORT,
    LOOPBACK_PEER,
    SELF_ORIGIN,
    UNTRUSTED,
    exchange,
    untrusted_app,
)
from podcast_mcp.gui.middleware_security_headers import GUI_CSP
from podcast_mcp.gui.server import create_app
from podcast_mcp.util.host_platform import MACOS
from podcast_mcp.util.host_session_wire import EXCHANGE_PARAM, EXCHANGE_PATH

STATUS = "/api/bootstrap/status"
ORIGIN_REFUSED = {"detail": "Origin not allowed for host GUI"}
REFERER_REFUSED = {"detail": "Referer not allowed for host GUI"}


@pytest.fixture(autouse=True)
def cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))


@pytest.fixture
def app(host):
    host(UNTRUSTED)
    return untrusted_app()


@pytest.fixture
def client(app) -> TestClient:
    signed_in = TestClient(app, client=LOOPBACK_PEER)
    exchange(signed_in, app)
    return signed_in


def test_the_engines_own_origin_is_admitted(client) -> None:
    assert client.get(STATUS, headers={"Origin": SELF_ORIGIN}).status_code == 200
    assert client.get(STATUS, headers={"Referer": f"{SELF_ORIGIN}/projects?x=1"}).status_code == 200


@pytest.mark.parametrize(
    "origin",
    [
        f"http://127.0.0.1:{LISTEN_PORT + 1}",
        f"http://localhost:{LISTEN_PORT}",
        f"https://127.0.0.1:{LISTEN_PORT}",
        f"http://127.0.0.1:{LISTEN_PORT}@evil.example",
        f"http://user@127.0.0.1:{LISTEN_PORT}",
        "http://127.0.0.1",
        "http://127.0.0.1:5173",
        "null",
        "https://evil.example",
    ],
)
def test_a_cookie_with_any_other_origin_is_refused(client, origin: str) -> None:
    response = client.get(STATUS, headers={"Origin": origin})

    assert (response.status_code, response.json()) == (403, ORIGIN_REFUSED)


def test_a_foreign_loopback_port_is_refused_on_a_write_too(client) -> None:
    response = client.post(
        "/api/pipeline/cancel", headers={"Origin": f"http://127.0.0.1:{LISTEN_PORT + 1}"}
    )

    assert (response.status_code, response.json()) == (403, ORIGIN_REFUSED)


def test_a_foreign_referer_is_refused(client) -> None:
    response = client.get(STATUS, headers={"Referer": f"http://127.0.0.1:{LISTEN_PORT + 1}/x"})

    assert (response.status_code, response.json()) == (403, REFERER_REFUSED)


def test_a_route_outside_the_old_prefix_list_is_bound_too(client) -> None:
    response = client.get("/api/speaker/profiles", headers={"Origin": "http://127.0.0.1:1"})

    assert (response.status_code, response.json()) == (403, ORIGIN_REFUSED)


def test_a_server_that_has_not_bound_a_port_refuses_every_origin(host) -> None:
    host(UNTRUSTED)
    unbound = create_app()
    client = TestClient(unbound, client=LOOPBACK_PEER)

    response = client.get(STATUS, headers={"Origin": SELF_ORIGIN})

    assert (response.status_code, response.json()) == (403, ORIGIN_REFUSED)


def test_the_host_socket_connects_from_the_engines_origin_only(
    client, minimal_project: Path
) -> None:
    url = "/api/host/ws?" + urlencode(
        {"path": str(minimal_project), "client_id": "owner-a", "document_client_id": "owner-b"}
    )

    with client.websocket_connect(url, headers={"Origin": SELF_ORIGIN}) as socket:
        assert socket.receive_json()["type"] == "Snapshot"
    with pytest.raises(WebSocketDisconnect) as foreign:
        with client.websocket_connect(
            url, headers={"Origin": f"http://127.0.0.1:{LISTEN_PORT + 1}"}
        ):
            pass

    assert foreign.value.code == 4403
    assert foreign.value.reason == "Origin not allowed for host GUI"


def test_the_exchange_route_answers_a_request_from_the_shell_that_launched_the_web_view(
    app,
) -> None:
    code = app.state.host_sessions.issue_code()

    response = TestClient(app, client=LOOPBACK_PEER).get(
        EXCHANGE_PATH,
        params={EXCHANGE_PARAM: code},
        headers={"Referer": "tauri://localhost/", "Origin": "tauri://localhost"},
        follow_redirects=False,
    )

    assert response.status_code == 303


def test_the_exchange_route_still_refuses_a_forged_host_header(app) -> None:
    code = app.state.host_sessions.issue_code()

    response = TestClient(app, client=LOOPBACK_PEER).get(
        EXCHANGE_PATH,
        params={EXCHANGE_PARAM: code},
        headers={"Host": "rebind.example"},
        follow_redirects=False,
    )

    assert response.status_code == 400


def test_no_dev_origin_may_read_a_credentialed_response(client) -> None:
    response = client.get(STATUS, headers={"Origin": "http://127.0.0.1:5173"})

    assert response.status_code == 403
    assert "access-control-allow-origin" not in response.headers
    preflight = client.options(
        "/api/features",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
    )
    assert "access-control-allow-origin" not in preflight.headers


def test_the_policy_connects_to_its_own_port_and_sends_no_referrer(client) -> None:
    for response in (client.get(STATUS), client.get("/")):
        assert response.headers["referrer-policy"] == "no-referrer"
        assert (
            "connect-src 'self' ws://127.0.0.1:49321; media-src 'self' blob:"
            in response.headers["content-security-policy"]
        )
        assert "127.0.0.1:*" not in response.headers["content-security-policy"]


def test_a_trusted_host_keeps_its_policy_and_its_dev_origins(host) -> None:
    host(MACOS)
    client = TestClient(create_app(), client=LOOPBACK_PEER)

    response = client.get(STATUS, headers={"Origin": "http://127.0.0.1:5173"})

    assert response.status_code == 200
    assert response.headers["content-security-policy"] == GUI_CSP
    assert "referrer-policy" not in response.headers
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"


@pytest.mark.parametrize(
    "path", ["/api/review/unknown-share/project", "/api/rec/unknown-share/state"]
)
def test_share_guest_routes_keep_their_own_origins(client, path: str) -> None:
    response = client.get(path, headers={"Origin": "https://guest.example"})

    assert response.json() != ORIGIN_REFUSED
