"""The debug-build request audit never records a secret and cannot run outside a debug build."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI

from podcast_mcp.gui import request_audit
from podcast_mcp.gui.request_audit import AUDIT_VARIABLE, DEBUG_BUILD_VARIABLE, RequestAudit


async def _answer_200(scope: Any, receive: Any, send: Any) -> None:
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": b"secret-body"})


async def _accept_socket(scope: Any, receive: Any, send: Any) -> None:
    await send({"type": "websocket.accept"})


async def _refuse_socket(scope: Any, receive: Any, send: Any) -> None:
    await send({"type": "websocket.close", "code": 1008})


def _call(app: Any, scope: dict[str, Any]) -> None:
    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        return None

    asyncio.run(app(scope, receive, send))


def _http(path: str, query: bytes, *, method: str = "GET") -> dict[str, Any]:
    return {
        "type": "http",
        "method": method,
        "path": path,
        "query_string": query,
        "headers": [(b"cookie", b"sharecut_session=secret-cookie")],
    }


def _lines(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def test_a_request_with_a_secret_query_logs_no_secret(tmp_path: Path) -> None:
    log = tmp_path / "logs" / "request-audit.jsonl"
    app = RequestAudit(_answer_200, log)

    _call(app, _http("/api/session/exchange", b"code=secret"))
    _call(app, _http("/api/health", b""))

    assert "secret" not in log.read_text(encoding="utf-8")
    assert _lines(log) == [
        {"method": "GET", "path": "/api/session/exchange", "status": 200, "query_empty": False},
        {"method": "GET", "path": "/api/health", "status": 200, "query_empty": True},
    ]


def test_a_websocket_accept_and_a_refusal_are_one_line_each(tmp_path: Path) -> None:
    log = tmp_path / "request-audit.jsonl"
    scope = {"type": "websocket", "path": "/api/host/ws", "query_string": b"", "headers": []}

    _call(RequestAudit(_accept_socket, log), scope)
    _call(RequestAudit(_refuse_socket, tmp_path / "refused.jsonl"), scope)

    assert _lines(log) == [
        {"method": "WEBSOCKET", "path": "/api/host/ws", "status": 101, "query_empty": True}
    ]
    assert _lines(tmp_path / "refused.jsonl") == [
        {"method": "WEBSOCKET", "path": "/api/host/ws", "status": 403, "query_empty": True}
    ]


def test_a_new_audit_starts_an_empty_file(tmp_path: Path) -> None:
    log = tmp_path / "request-audit.jsonl"
    log.write_text("an earlier run\n", encoding="utf-8")

    RequestAudit(_answer_200, log)

    assert log.read_text(encoding="utf-8") == ""


@pytest.mark.parametrize(
    ("variables", "expected"),
    [
        ({AUDIT_VARIABLE: "1", DEBUG_BUILD_VARIABLE: "1"}, True),
        ({AUDIT_VARIABLE: "1"}, False),
        ({DEBUG_BUILD_VARIABLE: "1"}, False),
        ({}, False),
        ({AUDIT_VARIABLE: "0", DEBUG_BUILD_VARIABLE: "1"}, False),
    ],
)
def test_the_audit_needs_the_debug_marker_and_the_request(
    monkeypatch: pytest.MonkeyPatch, variables: dict[str, str], expected: bool
) -> None:
    monkeypatch.delenv(AUDIT_VARIABLE, raising=False)
    monkeypatch.delenv(DEBUG_BUILD_VARIABLE, raising=False)
    for name, value in variables.items():
        monkeypatch.setenv(name, value)

    assert request_audit.enabled() is expected


def test_asking_without_the_debug_marker_is_refused_in_words(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv(DEBUG_BUILD_VARIABLE, raising=False)
    monkeypatch.setenv(AUDIT_VARIABLE, "1")

    with caplog.at_level(logging.WARNING, logger=request_audit.log.name):
        assert request_audit.enabled() is False

    assert "stays off" in caplog.text


def test_install_adds_the_middleware_only_when_enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(AUDIT_VARIABLE, raising=False)
    monkeypatch.delenv(DEBUG_BUILD_VARIABLE, raising=False)
    off, on = FastAPI(), FastAPI()

    request_audit.install(off)
    monkeypatch.setenv(AUDIT_VARIABLE, "1")
    monkeypatch.setenv(DEBUG_BUILD_VARIABLE, "1")
    request_audit.install(on)

    assert [m.cls for m in off.user_middleware] == []
    assert [m.cls for m in on.user_middleware] == [RequestAudit]


def test_a_share_link_token_in_the_path_is_not_written(tmp_path: Path) -> None:
    log = tmp_path / "request-audit.jsonl"
    app = RequestAudit(_answer_200, log)
    socket = {"type": "websocket", "path": "/api/rec/velvet-quokka-umbra/ws", "query_string": b""}

    _call(app, _http("/api/shares/velvet-quokka-umbra/revoke", b"", method="POST"))
    _call(RequestAudit(_accept_socket, tmp_path / "ws.jsonl"), socket)

    assert "quokka" not in log.read_text(encoding="utf-8")
    assert _lines(log)[0]["path"] == "/api/shares/<share-token>/revoke"
    assert _lines(tmp_path / "ws.jsonl")[0]["path"] == "/api/rec/<share-token>/ws"
