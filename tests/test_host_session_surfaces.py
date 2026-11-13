"""What a host whose loopback is not trusted does not serve, and what it serves only to a session."""

from __future__ import annotations

import threading
from pathlib import Path
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient
from starlette.testclient import WebSocketDenialResponse
from starlette.websockets import WebSocketDisconnect

from host_session_helpers import LOOPBACK_PEER, OWNER_TOKEN, UNTRUSTED, exchange, untrusted_app
from podcast_mcp.gui import bind
from podcast_mcp.gui.routes import handoff
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services.app import studio_host_path
from podcast_mcp.util.host_platform import MACOS

SHELL = "<!doctype html><title>shell</title><div id=root></div>"
EPISODE = "Quarterly Secrets Episode"


@pytest.fixture(autouse=True)
def cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", OWNER_TOKEN)


@pytest.fixture
def named_project(minimal_project: Path) -> Path:
    project = load_project(minimal_project)
    project.meta.name = EPISODE
    save_project(project, minimal_project)
    return minimal_project


@pytest.fixture
def static_dir(tmp_path: Path) -> Path:
    root = tmp_path / "static"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text(SHELL, encoding="utf-8")
    return root


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_a_trusted_host_still_serves_its_api_documentation(host, path: str) -> None:
    host(MACOS)

    assert TestClient(create_app(), client=LOOPBACK_PEER).get(path).status_code == 200


def test_a_trusted_host_still_mounts_the_handoff_routes(host) -> None:
    host(MACOS)

    response = TestClient(create_app(), client=LOOPBACK_PEER).get("/api/handoff/ping")

    assert response.status_code != 404


def test_a_trusted_host_still_announces_its_project(host, named_project: Path) -> None:
    host(MACOS)
    app = create_app(served_project=named_project)

    handoff.listening(app, port=49321, host="127.0.0.1")

    assert studio_host_path(named_project).exists()
    handoff.stopped(app)


def test_the_page_names_no_episode_until_a_session_exists(
    host, named_project: Path, static_dir: Path
) -> None:
    host(UNTRUSTED)
    app = untrusted_app(static_dir=static_dir, served_project=named_project)
    client = TestClient(app, client=LOOPBACK_PEER)

    bare = client.get("/", follow_redirects=False)
    exchange(client, app)
    signed_in = client.get("/", follow_redirects=False)

    assert (bare.status_code, bare.text) == (200, SHELL)
    assert EPISODE not in bare.text
    assert signed_in.status_code == 307
    assert signed_in.headers["location"] == f"?{urlencode({'project': str(named_project)})}"
    assert EPISODE in client.get(f"/?project={named_project}").text


def test_a_mismatched_project_link_names_nothing_without_a_session(
    host, named_project: Path, static_dir: Path
) -> None:
    host(UNTRUSTED)
    app = untrusted_app(static_dir=static_dir, served_project=named_project)

    response = TestClient(app, client=LOOPBACK_PEER).get(
        "/?project=/elsewhere/episode.sharecut", headers={"Accept": "text/html"}
    )

    assert (response.status_code, response.text) == (200, SHELL)


def test_a_page_token_is_not_carried_into_the_redirect(
    host, named_project: Path, static_dir: Path
) -> None:
    host(UNTRUSTED)
    app = untrusted_app(static_dir=static_dir, served_project=named_project)
    client = TestClient(app, client=LOOPBACK_PEER)
    exchange(client, app)

    response = client.get(f"/?session_token={OWNER_TOKEN}", follow_redirects=False)

    assert response.status_code == 307
    assert response.headers["location"] == f"?{urlencode({'project': str(named_project)})}"


def _socket_url(path: Path) -> str:
    return "/api/host/ws?" + urlencode(
        {"path": str(path), "client_id": "owner-a", "document_client_id": "owner-b"}
    )


def test_the_host_socket_refuses_an_existing_and_a_missing_path_alike(
    host, minimal_project: Path, tmp_path: Path
) -> None:
    host(UNTRUSTED)
    client = TestClient(untrusted_app(), client=LOOPBACK_PEER)

    closes = []
    for path in (minimal_project, tmp_path / "missing" / "episode.sharecut"):
        with pytest.raises(WebSocketDisconnect) as closed:
            with client.websocket_connect(_socket_url(path)):
                pass
        closes.append((closed.value.code, closed.value.reason))

    assert closes == [(4403, "this host requires an owner session")] * 2


def test_the_host_socket_gives_a_signed_in_owner_the_missing_path_answer(
    host, tmp_path: Path
) -> None:
    host(UNTRUSTED)
    app = untrusted_app()
    client = TestClient(app, client=LOOPBACK_PEER)
    exchange(client, app)

    with pytest.raises(WebSocketDenialResponse) as failed:
        with client.websocket_connect(_socket_url(tmp_path / "missing" / "episode.sharecut")):
            pass

    assert failed.value.status_code == 404


def _serve_and_request(
    app: object, request: str, capfd: pytest.CaptureFixture[str], *, access_log: bool
) -> str:
    import http.client

    sock = bind.exclusive_listen_socket("127.0.0.1", 0)
    server = bind.build_gui_server(app, sock, log_level="info", access_log=access_log)
    thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
    thread.start()
    while not server.started:
        thread.join(0.02)
    try:
        connection = http.client.HTTPConnection("127.0.0.1", sock.getsockname()[1], timeout=10)
        connection.request("GET", request)
        connection.getresponse().read()
    finally:
        server.should_exit = True
        thread.join(10)
        sock.close()
    captured = capfd.readouterr()
    return captured.out + captured.err


def test_the_access_log_can_be_turned_off_so_no_url_is_logged(
    host, capfd: pytest.CaptureFixture[str]
) -> None:
    host(UNTRUSTED)
    request = "/api/health?marker=never-log-this-url"

    logged = _serve_and_request(untrusted_app(), request, capfd, access_log=True)
    silent = _serve_and_request(untrusted_app(), request, capfd, access_log=False)

    assert "never-log-this-url" in logged
    assert "never-log-this-url" not in silent
