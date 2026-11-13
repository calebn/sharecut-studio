"""A host whose loopback is trusted decides every owner request as it did before the one resolver.

Each probe goes through the real app. The table is the decision for a strict host reached from a
remote peer, the only combination where the credential's source matters: a route admits a source
or it does not. Every other combination (loopback peer, authz not strict) admits all of them.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from podcast_mcp.gui.server import create_app
from podcast_mcp.project import store
from podcast_mcp.util.host_platform import LINUX, MACOS

TOKEN = "s3cret-token"
REMOTE = ("203.0.113.9", 50000)
LOOPBACK = ("127.0.0.1", 50000)
DENIED_CODE = "authz_denied"

PRESENTATIONS = (
    "none",
    "header",
    "header_wrong",
    "query_token",
    "query_token_wrong",
    "query_session_token",
    "body_token",
)

COMMAND_BODY: dict[str, Any] = {
    "client_id": "table-client",
    "type": "AddComment",
    "role": "viewer",
    "payload": {"body": "x", "author": "a", "timeline_start": 1.0},
}


def _attach(presentation: str, url: str) -> tuple[str, dict[str, str], dict[str, Any]]:
    """The url, headers and extra body fields that carry *presentation*."""
    sep = "&" if "?" in url else "?"
    if presentation == "header":
        return url, {"X-Podcast-Token": TOKEN}, {}
    if presentation == "header_wrong":
        return url, {"X-Podcast-Token": "wrong"}, {}
    if presentation == "query_token":
        return f"{url}{sep}{urlencode({'token': TOKEN})}", {}, {}
    if presentation == "query_token_wrong":
        return f"{url}{sep}{urlencode({'token': 'wrong'})}", {}, {}
    if presentation == "query_session_token":
        return f"{url}{sep}{urlencode({'session_token': TOKEN})}", {}, {}
    if presentation == "body_token":
        return url, {}, {"token": TOKEN}
    return url, {}, {}


def _denied(response: Any) -> bool:
    return response.status_code == 403 and response.headers.get("X-Sharecut-Error-Code") == (
        DENIED_CODE
    )


def _http(
    method: str, url: str, json: dict[str, Any] | None = None
) -> Callable[[TestClient, str], bool]:
    def probe(client: TestClient, presentation: str) -> bool:
        target, headers, extra = _attach(presentation, url)
        body = {**json, **extra} if json is not None else None
        return not _denied(client.request(method, target, headers=headers, json=body))

    return probe


def _root(client: TestClient, presentation: str) -> bool:
    target, headers, _ = _attach(presentation, "/")
    response = client.get(target, headers=headers, follow_redirects=False)
    return response.status_code == 307


def _socket(project: Path) -> Callable[[TestClient, str], bool]:
    base = "/api/host/ws?" + urlencode(
        {"path": str(project), "client_id": "owner-a", "document_client_id": "owner-b"}
    )

    def probe(client: TestClient, presentation: str) -> bool:
        target, headers, _ = _attach(presentation, base)
        try:
            with client.websocket_connect(target, headers=headers):
                return True
        except WebSocketDisconnect as closed:
            assert closed.code == 4403
            return False

    return probe


def _probes(project: Path) -> dict[str, Callable[[TestClient, str], bool]]:
    path = urlencode({"path": str(project)})
    return {
        "router gate": _http("GET", "/api/bootstrap/status"),
        "client gate": _http(
            "POST",
            "/api/comments",
            {"path": str(project), "body": "x", "author": "a", "timeline_start": 1.0},
        ),
        "session route": _http("GET", f"/api/session/meta?{path}"),
        "document command": _http("POST", f"/api/document/command?{path}", COMMAND_BODY),
        "suggestion helper": _http("GET", f"/api/session-suggestion/takes?{path}&suggestion_id=s"),
        "waveform helper": _http("GET", f"/api/waveform/status?{path}"),
        "export download": _http("GET", f"/api/export/files/x.mp3?{path}"),
        "pinned root": _root,
        "host socket": _socket(project),
    }


# The strict-remote decision of each probe, one flag per presentation, in PRESENTATIONS order.
# Recorded from the code before the one resolver (none, header, header_wrong, query_token,
# query_token_wrong, query_session_token, body_token).
ADMITTED: dict[str, tuple[bool, ...]] = {
    "router gate": (False, True, False, True, False, False, False),
    "client gate": (False, True, False, False, False, False, False),
    "session route": (False, True, False, True, False, False, False),
    "document command": (False, True, False, True, False, False, True),
    "suggestion helper": (False, True, False, True, False, False, False),
    "waveform helper": (False, True, False, True, False, False, False),
    "export download": (False, True, False, True, False, False, False),
    "pinned root": (False, False, False, False, False, True, False),
    "host socket": (False, False, False, True, False, False, False),
}


@pytest.fixture
def strict_app(minimal_project: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setattr(store, "_guard_mode", "warn")
    monkeypatch.setenv("PODCAST_SESSION_AUTHZ", "strict")
    monkeypatch.setenv("PODCAST_SESSION_TOKEN", TOKEN)
    static = tmp_path / "static"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>shell</title>", encoding="utf-8")
    return create_app(static_dir=static, served_project=minimal_project)


def observed(app: Any, project: Path, peer: tuple[str, int]) -> dict[str, tuple[bool, ...]]:
    client = TestClient(app, client=peer)
    return {
        name: tuple(probe(client, presentation) for presentation in PRESENTATIONS)
        for name, probe in _probes(project).items()
    }


@pytest.mark.parametrize("row", [MACOS, LINUX], ids=lambda row: row.name)
def test_a_strict_remote_peer_is_admitted_by_the_sources_each_route_names(
    row, host, strict_app, minimal_project: Path
) -> None:
    host(row)

    assert observed(strict_app, minimal_project, REMOTE) == ADMITTED


@pytest.mark.parametrize("row", [MACOS, LINUX], ids=lambda row: row.name)
def test_a_loopback_peer_is_admitted_with_no_credential(
    row, host, strict_app, minimal_project: Path
) -> None:
    host(row)

    assert observed(strict_app, minimal_project, LOOPBACK) == {
        name: (True,) * len(PRESENTATIONS) for name in ADMITTED
    }


@pytest.mark.parametrize("row", [MACOS, LINUX], ids=lambda row: row.name)
def test_every_peer_is_admitted_when_authz_is_not_strict(
    row, host, strict_app, minimal_project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("PODCAST_SESSION_AUTHZ")
    host(row)

    assert observed(strict_app, minimal_project, REMOTE) == {
        name: (True,) * len(PRESENTATIONS) for name in ADMITTED
    }


def test_a_trusted_host_has_no_exchange_route_and_sets_no_cookie(
    host, strict_app, minimal_project: Path
) -> None:
    host(MACOS)
    client = TestClient(strict_app, client=LOOPBACK)

    assert client.get("/api/session/exchange?code=anything").status_code == 404
    shell = client.get("/")
    assert shell.headers.get("set-cookie") is None
    assert "set-cookie" not in client.get(f"/api/project?path={minimal_project}").headers


@pytest.mark.parametrize("row", [MACOS, LINUX], ids=lambda row: row.name)
def test_the_host_socket_refuses_a_bad_token_before_it_looks_for_the_project(
    row, host, strict_app, tmp_path: Path
) -> None:
    host(row)
    url = "/api/host/ws?" + urlencode(
        {
            "path": str(tmp_path / "missing" / "episode.sharecut"),
            "client_id": "owner-a",
            "document_client_id": "owner-b",
            "token": "wrong",
        }
    )

    with pytest.raises(WebSocketDisconnect) as refused:
        with TestClient(strict_app, client=REMOTE).websocket_connect(url):
            pass

    assert refused.value.code == 4403
    assert refused.value.reason == "remote client requires PODCAST_SESSION_TOKEN"
