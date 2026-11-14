"""The embedded engine on a host whose loopback is not trusted, over a real loopback listener."""

from __future__ import annotations

import http.client
import json
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path

import pytest
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect

from host_session_helpers import OWNER_TOKEN, UNTRUSTED
from podcast_mcp.gui import embedded, request_audit
from podcast_mcp.gui.bind import BOOT_TOKEN_ENV
from podcast_mcp.services.jobs import shared_job_manager
from podcast_mcp.util import host_platform
from podcast_mcp.util.host_platform import IOS, MACOS, UNKNOWN
from podcast_mcp.util.host_session_wire import EXCHANGE_PARAM, EXCHANGE_PATH, SESSION_COOKIE


@pytest.fixture(autouse=True)
def engine(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    monkeypatch.setattr(embedded, "_ENGINE", embedded._Engine())
    monkeypatch.setenv(BOOT_TOKEN_ENV, "boot-token-for-tests")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", OWNER_TOKEN)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "home"))
    monkeypatch.setenv("PODCAST_MCP_CACHE", str(tmp_path / "cache"))
    yield
    embedded.stop()


def _get(
    port: int, path: str, *, cookie: str | None = None, headers: dict[str, str] | None = None
) -> http.client.HTTPResponse:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    sent = dict(headers or {})
    if cookie is not None:
        sent["Cookie"] = f"{SESSION_COOKIE}={cookie}"
    connection.request("GET", path, headers=sent)
    return connection.getresponse()


def _post(port: int, path: str, body: dict[str, str], cookie: str) -> http.client.HTTPResponse:
    """A POST the way the page sends it: its own origin and the session cookie."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    connection.request(
        "POST",
        path,
        body=json.dumps(body),
        headers={
            "Content-Type": "application/json",
            "Origin": f"http://127.0.0.1:{port}",
            "Cookie": f"{SESSION_COOKIE}={cookie}",
        },
    )
    return connection.getresponse()


def _sign_in(started: embedded.Started) -> str:
    response = _get(started.port, f"{EXCHANGE_PATH}?{EXCHANGE_PARAM}={started.exchange_code}")
    assert response.status == 200
    cookie = response.getheader("Set-Cookie") or ""
    return cookie.split(";")[0].partition("=")[2]


def test_a_trusted_host_gets_no_exchange_code(host) -> None:
    host(MACOS)

    started = embedded.start()

    assert started.exchange_code is None
    assert _get(started.port, f"{EXCHANGE_PATH}?{EXCHANGE_PARAM}=x").status == 404


def test_an_untrusted_host_gets_a_code_that_signs_the_web_view_in_once(host) -> None:
    host(UNTRUSTED)
    started = embedded.start()
    assert started.exchange_code

    cookie = _sign_in(started)
    again = _get(started.port, f"{EXCHANGE_PATH}?{EXCHANGE_PARAM}={started.exchange_code}")

    assert _get(started.port, "/api/bootstrap/status").status == 403
    assert _get(started.port, "/api/bootstrap/status", cookie=cookie).status == 200
    assert again.status == 403


def test_a_real_code_replayed_is_refused_and_sets_no_cookie(host) -> None:
    host(UNTRUSTED)
    started = embedded.start()
    path = f"{EXCHANGE_PATH}?{EXCHANGE_PARAM}={started.exchange_code}"

    first = _get(started.port, path)
    replay = _get(started.port, path)
    cookie = (first.getheader("Set-Cookie") or "").split(";")[0].partition("=")[2]

    assert first.status == 200 and cookie
    assert replay.status == 403
    assert replay.getheader("Set-Cookie") is None
    assert _get(started.port, "/api/bootstrap/status", cookie=cookie).status == 200


def test_the_request_audit_records_the_real_traffic_without_a_query_or_the_code(
    host, minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(request_audit.DEBUG_BUILD_VARIABLE, "1")
    monkeypatch.setenv(request_audit.AUDIT_VARIABLE, "1")
    host(UNTRUSTED)
    started = embedded.start()
    code = started.exchange_code
    cookie = _sign_in(started)
    _get(started.port, f"{EXCHANGE_PATH}?{EXCHANGE_PARAM}={code}")
    job = shared_job_manager().adopt_agent_job(tool_id="test", label="Test", claim="streaming")
    _get(started.port, f"/api/pipeline/events?job_id={job.id}", cookie=cookie).close()
    url = (
        f"ws://127.0.0.1:{started.port}/api/host/ws?path={minimal_project}"
        "&client_id=owner-a&document_client_id=owner-b"
    )
    with connect(url, additional_headers={"Cookie": f"{SESSION_COOKIE}={cookie}"}) as socket:
        socket.recv()

    refused = _post(started.port, "/api/project/open", {"path": "/none/episode.sharecut"}, cookie)

    text = request_audit.audit_path().read_text(encoding="utf-8")
    lines = [json.loads(line) for line in text.splitlines()]
    assert refused.status == 404  # the route answered; the Origin check still knows the port
    assert code and code not in text and cookie not in text and str(minimal_project) not in text
    assert {"method": "GET", "path": EXCHANGE_PATH, "status": 200, "query_empty": False} in lines
    assert {"method": "GET", "path": EXCHANGE_PATH, "status": 403, "query_empty": False} in lines
    assert sum(1 for line in lines if line["path"] == EXCHANGE_PATH and line["status"] == 200) == 1
    assert {
        "method": "GET",
        "path": "/api/pipeline/events",
        "status": 200,
        "query_empty": False,
    } in lines
    assert job.id not in text
    assert {
        "method": "WEBSOCKET",
        "path": "/api/host/ws",
        "status": 101,
        "query_empty": False,
    } in lines


@pytest.mark.parametrize("row", [IOS, UNKNOWN], ids=["ios", "unknown"])
def test_every_row_whose_loopback_is_not_trusted_gets_the_same_code_and_cookie(host, row) -> None:
    host(replace(host_platform.current(), name=row.name, loopback_is_trusted=False))
    started = embedded.start()
    assert started.exchange_code

    cookie = _sign_in(started)

    assert _get(started.port, "/api/bootstrap/status").status == 403
    assert _get(started.port, "/api/bootstrap/status", cookie=cookie).status == 200


def test_every_start_mints_a_fresh_code_on_the_same_port(host) -> None:
    host(UNTRUSTED)
    first = embedded.start()
    second = embedded.start()

    assert second.port == first.port
    assert second.exchange_code and second.exchange_code != first.exchange_code
    assert _sign_in(second)
    assert _get(first.port, f"{EXCHANGE_PATH}?{EXCHANGE_PARAM}={first.exchange_code}").status == 200


def test_the_cookie_alone_opens_an_event_stream(host) -> None:
    host(UNTRUSTED)
    started = embedded.start()
    cookie = _sign_in(started)
    job = shared_job_manager().adopt_agent_job(tool_id="test", label="Test", claim="streaming")
    url = f"/api/pipeline/events?job_id={job.id}"

    refused = _get(started.port, url)
    with_token = _get(started.port, url, headers={"X-Podcast-Token": OWNER_TOKEN})
    admitted = _get(started.port, url, cookie=cookie)

    assert (refused.status, with_token.status) == (403, 403)
    assert admitted.status == 200
    assert (admitted.getheader("content-type") or "").startswith("text/event-stream")


def test_the_cookie_alone_opens_the_host_socket(host, minimal_project: Path) -> None:
    host(UNTRUSTED)
    started = embedded.start()
    cookie = _sign_in(started)
    url = (
        f"ws://127.0.0.1:{started.port}/api/host/ws?path={minimal_project}"
        "&client_id=owner-a&document_client_id=owner-b"
    )

    with connect(url, additional_headers={"Cookie": f"{SESSION_COOKIE}={cookie}"}) as socket:
        first = json.loads(socket.recv())
    with pytest.raises(InvalidStatus) as refused:
        connect(url)

    assert (first["plane"], first["type"]) == ("session", "Snapshot")
    assert refused.value.response.status_code == 403


def test_the_host_socket_answers_only_the_engines_own_origin(host, minimal_project: Path) -> None:
    host(UNTRUSTED)
    started = embedded.start()
    cookie = f"{SESSION_COOKIE}={_sign_in(started)}"
    url = (
        f"ws://127.0.0.1:{started.port}/api/host/ws?path={minimal_project}"
        "&client_id=owner-a&document_client_id=owner-b"
    )
    own = f"http://127.0.0.1:{started.port}"
    other = f"http://127.0.0.1:{started.port + 1}"

    with connect(url, additional_headers={"Cookie": cookie, "Origin": own}) as socket:
        assert json.loads(socket.recv())["type"] == "Snapshot"
    with pytest.raises(InvalidStatus) as foreign:
        connect(url, additional_headers={"Cookie": cookie, "Origin": other})

    assert foreign.value.response.status_code == 403
    response = _get(started.port, "/api/bootstrap/status", cookie=cookie.partition("=")[2])
    assert response.getheader("Referrer-Policy") == "no-referrer"
    assert f"ws://127.0.0.1:{started.port};" in (
        response.getheader("Content-Security-Policy") or ""
    )
