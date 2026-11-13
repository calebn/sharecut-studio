"""A host whose loopback is not trusted: the exchange route, and the cookie as the one owner credential."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from host_session_helpers import (
    LOOPBACK_PEER,
    OWNER_TOKEN,
    UNTRUSTED,
    exchange,
    untrusted_app,
)
from podcast_mcp.util.host_session_wire import EXCHANGE_PARAM, EXCHANGE_PATH, SESSION_COOKIE
from podcast_mcp.util.proxy_paths import RELAYED_REQUEST_HEADER

DENIED = "authz_denied"


@pytest.fixture(autouse=True)
def owner_token(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", OWNER_TOKEN)
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))


@pytest.fixture
def app(host):
    host(UNTRUSTED)
    return untrusted_app()


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app, client=LOOPBACK_PEER)


def _attributes(set_cookie: str) -> set[str]:
    return {part.strip().lower() for part in set_cookie.split(";")[1:]}


def test_a_valid_code_sets_the_session_cookie_and_redirects_to_a_clean_root(app, client) -> None:
    code = app.state.host_sessions.issue_code()

    response = client.get(EXCHANGE_PATH, params={EXCHANGE_PARAM: code}, follow_redirects=False)

    assert response.status_code == 303
    assert response.headers["location"] == "/"
    assert response.headers["cache-control"] == "no-store"
    cookie = response.headers["set-cookie"]
    name, _, value = cookie.split(";")[0].partition("=")
    assert name == "sharecut_host_session"
    assert app.state.host_sessions.is_live(value) is True
    assert _attributes(cookie) == {"httponly", "path=/", "samesite=strict"}
    assert code not in response.text + response.headers["location"] + cookie


def test_the_code_works_once(app, client) -> None:
    code = app.state.host_sessions.issue_code()
    first = client.get(EXCHANGE_PATH, params={EXCHANGE_PARAM: code}, follow_redirects=False)

    second = TestClient(app, client=LOOPBACK_PEER).get(
        EXCHANGE_PATH, params={EXCHANGE_PARAM: code}, follow_redirects=False
    )

    assert first.status_code == 303
    assert second.status_code == 403
    assert "set-cookie" not in second.headers


@pytest.mark.parametrize("presented", ["wrong-code", ""])
def test_a_wrong_code_is_refused_with_no_cookie(app, client, presented: str) -> None:
    app.state.host_sessions.issue_code()

    response = client.get(EXCHANGE_PATH, params={EXCHANGE_PARAM: presented}, follow_redirects=False)

    assert response.status_code == 403
    assert response.headers["X-Sharecut-Error-Code"] == "session_exchange_refused"
    assert response.json() == {
        "detail": "This link was already used or has expired. Reopen the app."
    }
    assert "set-cookie" not in response.headers


def test_a_request_with_no_code_is_refused(client) -> None:
    response = client.get(EXCHANGE_PATH, follow_redirects=False)

    assert response.status_code == 403
    assert "set-cookie" not in response.headers


def test_an_expired_code_is_refused(app, client, monkeypatch: pytest.MonkeyPatch) -> None:
    clock = {"now": 5000.0}
    sessions = type(app.state.host_sessions)(clock=lambda: clock["now"])
    app.state.host_sessions = sessions
    code = sessions.issue_code()
    clock["now"] += 60

    response = client.get(EXCHANGE_PATH, params={EXCHANGE_PARAM: code}, follow_redirects=False)

    assert response.status_code == 403
    assert "set-cookie" not in response.headers


def test_without_the_cookie_an_owner_route_is_refused_whatever_else_is_sent(client) -> None:
    refused = client.get("/api/bootstrap/status")
    with_header = client.get("/api/bootstrap/status", headers={"X-Podcast-Token": OWNER_TOKEN})
    with_query = client.get("/api/bootstrap/status", params={"token": OWNER_TOKEN})

    for response in (refused, with_header, with_query):
        assert response.status_code == 403
        assert response.headers["X-Sharecut-Error-Code"] == DENIED
        assert response.json() == {"detail": "this host requires an owner session"}


def test_a_page_token_is_not_a_credential_here(client) -> None:
    assert (
        client.get("/api/bootstrap/status", params={"session_token": OWNER_TOKEN}).status_code
        == 403
    )


def test_with_the_cookie_an_owner_route_answers_with_no_token_anywhere(app, client) -> None:
    exchange(client, app)

    response = client.get("/api/bootstrap/status")

    assert response.status_code == 200
    assert response.json()["host"]["name"] == UNTRUSTED.name
    assert "token" not in str(response.request.url)


def test_a_cookie_from_another_launch_matches_nothing(app, client) -> None:
    client.cookies.set(SESSION_COOKIE, "left-over-from-an-earlier-launch")

    assert client.get("/api/bootstrap/status").status_code == 403


def test_a_relayed_request_is_refused_even_with_the_cookie(app, client) -> None:
    exchange(client, app)

    response = client.get("/api/bootstrap/status", headers={RELAYED_REQUEST_HEADER: "1"})

    assert response.status_code == 403
    assert response.headers["X-Sharecut-Error-Code"] == DENIED


@pytest.mark.parametrize(
    "route",
    ["/api/session/meta", "/api/document/state", "/api/waveform/status", "/api/export/files"],
)
def test_every_kind_of_owner_gate_admits_the_cookie_and_refuses_its_absence(
    app, client, minimal_project: Path, route: str
) -> None:
    params = {"path": str(minimal_project)}

    refused = client.get(route, params=params)
    exchange(client, app)
    admitted = client.get(route, params=params)

    assert refused.status_code == 403
    assert refused.headers["X-Sharecut-Error-Code"] == DENIED
    assert admitted.status_code == 200


def _socket_url(project: Path) -> str:
    return "/api/host/ws?" + urlencode(
        {"path": str(project), "client_id": "owner-a", "document_client_id": "owner-b"}
    )


def test_the_host_socket_connects_with_the_cookie_and_no_token_in_the_url(
    app, client, minimal_project: Path
) -> None:
    exchange(client, app)

    with client.websocket_connect(_socket_url(minimal_project)) as socket:
        first = socket.receive_json()

    assert (first["plane"], first["type"]) == ("session", "Snapshot")


def test_the_host_socket_refuses_a_caller_with_only_the_token(
    client, minimal_project: Path
) -> None:
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect(_socket_url(minimal_project) + f"&token={OWNER_TOKEN}"):
            pass

    assert closed.value.code == 4403


def test_a_media_route_serves_bytes_to_the_cookie(
    app, client, minimal_project: Path, sample_wav: Path
) -> None:
    from podcast_mcp.models import load_project

    premix = Path(load_project(minimal_project).workspace_dir) / "artifacts" / "premix.wav"
    premix.parent.mkdir(parents=True, exist_ok=True)
    premix.write_bytes(sample_wav.read_bytes())
    params = {"path": str(minimal_project), "kind": "premix"}

    refused = client.get("/api/audio", params=params)
    exchange(client, app)
    served = client.get("/api/audio", params=params)

    assert refused.status_code == 403
    assert served.status_code == 200
    assert served.content == sample_wav.read_bytes()
    assert "token" not in str(served.request.url)
