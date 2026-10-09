"""Exclusive GUI bind, listen file, and boot-token health."""

from __future__ import annotations

import os
import socket
import stat
import sys
from pathlib import Path
from typing import Any, cast

import pytest

from podcast_mcp.gui.bind import (
    BOOT_TOKEN_ENV,
    BOOT_TOKEN_HEADER,
    EPHEMERAL_ENV,
    LISTEN_FILE_ENV,
    boot_token_accepted,
    exclusive_listen_socket,
    gui_server_deps_available,
    resolved_bind_port,
    run_gui_server,
    write_listen_file,
)
from podcast_mcp.gui.middleware_security_headers import GUI_CSP


def test_gui_server_deps_available() -> None:
    assert gui_server_deps_available() is True


def test_resolved_bind_port_ephemeral(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(EPHEMERAL_ENV, raising=False)
    assert resolved_bind_port(8765) == 8765
    monkeypatch.setenv(EPHEMERAL_ENV, "1")
    assert resolved_bind_port(8765) == 0


def test_boot_token_accepted_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(BOOT_TOKEN_ENV, raising=False)
    assert boot_token_accepted(None)
    assert boot_token_accepted("anything")


def test_boot_token_compare_digest(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(BOOT_TOKEN_ENV, "abc")
    assert boot_token_accepted("abc")
    assert not boot_token_accepted("ab")
    assert not boot_token_accepted(None)
    assert not boot_token_accepted("abcd")
    assert not boot_token_accepted(cast(Any, b"abc"))


def test_exclusive_listen_windows_without_exclusive_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from unittest.mock import MagicMock

    monkeypatch.setattr("podcast_mcp.gui.bind.sys.platform", "win32")
    monkeypatch.delattr("podcast_mcp.gui.bind.socket.SO_EXCLUSIVEADDRUSE", raising=False)
    sock = MagicMock()
    monkeypatch.setattr("podcast_mcp.gui.bind.socket.socket", lambda *_a, **_k: sock)
    with pytest.raises(OSError, match="SO_EXCLUSIVEADDRUSE"):
        exclusive_listen_socket("127.0.0.1", 8765)
    sock.close.assert_called_once()
    sock.bind.assert_not_called()


def test_exclusive_listen_windows_exclusive_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    from unittest.mock import MagicMock

    monkeypatch.setattr("podcast_mcp.gui.bind.sys.platform", "win32")
    monkeypatch.setattr("podcast_mcp.gui.bind.socket.SO_EXCLUSIVEADDRUSE", 14, raising=False)
    sock = MagicMock()
    monkeypatch.setattr("podcast_mcp.gui.bind.socket.socket", lambda *_a, **_k: sock)
    exclusive_listen_socket("127.0.0.1", 0)
    sock.setsockopt.assert_called_once()
    sock.bind.assert_called_once_with(("127.0.0.1", 0))
    sock.listen.assert_called_once()


def _patch_uvicorn_server(monkeypatch: pytest.MonkeyPatch, seen: dict[str, object]) -> None:
    import uvicorn

    class FakeConfig:
        def __init__(self, app: object, **kwargs: object) -> None:
            self.app = app
            seen.update(kwargs)
            seen["app"] = app

    class FakeServer:
        def __init__(self, config: FakeConfig) -> None:
            self.config = config

        def run(self, sockets: object = None) -> None:
            seen["sockets"] = sockets

    monkeypatch.setattr(uvicorn, "Config", FakeConfig)
    monkeypatch.setattr(uvicorn, "Server", FakeServer)


def test_public_bind_passes_the_open_listener_and_closes_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import uvicorn

    monkeypatch.delenv(EPHEMERAL_ENV, raising=False)
    monkeypatch.delenv(LISTEN_FILE_ENV, raising=False)
    app = object()
    observed: dict[str, Any] = {}

    class Config:
        def __init__(self, supplied_app: object, **options: object) -> None:
            observed["app"] = supplied_app
            observed["options"] = options

    class Server:
        def __init__(self, config: Config) -> None:
            self.config = config

        def run(self, *, sockets: list[socket.socket]) -> None:
            assert len(sockets) == 1
            listener = sockets[0]
            observed["listener"] = listener
            observed["host"] = listener.getsockname()[0]
            observed["accepts"] = listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN)
            contender = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                with pytest.raises(OSError):
                    contender.bind(listener.getsockname())
            finally:
                contender.close()

    monkeypatch.setattr(uvicorn, "Config", Config)
    monkeypatch.setattr(uvicorn, "Server", Server)
    run_gui_server(app, host="127.0.0.1", port=0, log_level="warning")
    assert observed["app"] is app
    assert observed["host"] == "127.0.0.1"
    assert observed["accepts"] == 1
    assert observed["options"] == {
        "log_level": "warning",
        "ws_per_message_deflate": True,
    }
    assert observed["listener"].fileno() == -1


def test_exclusive_listen_second_bind_fails() -> None:
    sock = exclusive_listen_socket("127.0.0.1", 0)
    try:
        port = int(sock.getsockname()[1])
        assert port != 0
        with pytest.raises(OSError):
            exclusive_listen_socket("127.0.0.1", port)
    finally:
        sock.close()


def test_write_listen_file_mode_0600(tmp_path: Path) -> None:
    from podcast_mcp.util.atomic_json import write_json_atomic

    path = tmp_path / "sidecar.listen.json"
    write_listen_file(path, port=54321, pid=99)
    assert path.read_text(encoding="utf-8") == '{"port":54321,"pid":99}\n'
    if sys.platform != "win32":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    pretty = tmp_path / "pretty.json"
    write_json_atomic(pretty, {"a": 1})
    assert pretty.read_text(encoding="utf-8") == '{\n  "a": 1\n}\n'


def test_run_gui_server_passes_sockets_and_listen_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import uvicorn

    listen = tmp_path / "sidecar.listen.json"
    monkeypatch.setenv(LISTEN_FILE_ENV, str(listen))
    monkeypatch.setenv(EPHEMERAL_ENV, "1")
    seen: dict[str, object] = {}

    class FakeConfig:
        def __init__(self, app: object, **kwargs: object) -> None:
            self.app = app
            seen.update(kwargs)
            seen["app"] = app

    class FakeServer:
        def __init__(self, config: FakeConfig) -> None:
            self.config = config

        def run(self, sockets: object = None) -> None:
            seen["sockets"] = sockets
            seen["payload"] = listen.read_text(encoding="utf-8")

    monkeypatch.setattr(uvicorn, "Config", FakeConfig)
    monkeypatch.setattr(uvicorn, "Server", FakeServer)
    app = object()
    run_gui_server(app, host="127.0.0.1", port=8765, log_level="warning")
    assert seen["app"] is app
    sockets = seen["sockets"]
    assert isinstance(sockets, list) and len(sockets) == 1
    assert "fd" not in seen
    payload = str(seen["payload"])
    assert '"port":' in payload
    assert f'"pid":{os.getpid()}' in payload
    assert "secret" not in payload
    assert not listen.exists()


def test_run_gui_server_unlinks_listen_file_when_serve_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import uvicorn

    listen = tmp_path / "sidecar.listen.json"
    monkeypatch.setenv(LISTEN_FILE_ENV, str(listen))

    class FakeConfig:
        def __init__(self, app: object, **kwargs: object) -> None:
            self.app = app

    class FakeServer:
        def __init__(self, config: FakeConfig) -> None:
            self.config = config

        def run(self, sockets: object = None) -> None:
            raise RuntimeError("serve failed")

    monkeypatch.setattr(uvicorn, "Config", FakeConfig)
    monkeypatch.setattr(uvicorn, "Server", FakeServer)
    with pytest.raises(RuntimeError, match="serve failed"):
        run_gui_server(object(), host="127.0.0.1", port=0, log_level="warning")
    assert not listen.exists()


def test_openapi_disabled_when_env_off(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.setenv("PODCAST_GUI_OPENAPI", "0")
    client = TestClient(create_app())
    assert client.get("/openapi.json").status_code == 404
    assert client.get("/docs").status_code == 404


def test_cors_origins_append_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("fastapi")
    from podcast_mcp.gui.server import _cors_origins

    monkeypatch.setenv("PODCAST_REVIEW_CORS_ORIGINS", "http://127.0.0.1:54321")
    origins = _cors_origins()
    assert "http://127.0.0.1:54321" in origins
    assert "http://127.0.0.1:8765" in origins
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    secret = "a" * 64
    monkeypatch.delenv(BOOT_TOKEN_ENV, raising=False)
    client = TestClient(create_app())
    open_res = client.get("/api/health")
    assert open_res.status_code == 200
    assert open_res.json() == {"ok": True}
    assert secret not in open_res.text
    assert open_res.headers.get("content-security-policy") == GUI_CSP
    assert open_res.headers.get("x-frame-options") == "DENY"
    assert open_res.headers.get("x-content-type-options") == "nosniff"
    assert "frame-ancestors 'none'" in GUI_CSP

    monkeypatch.setenv(BOOT_TOKEN_ENV, secret)
    gated = TestClient(create_app())
    denied = gated.get("/api/health")
    assert denied.status_code == 401
    assert secret not in denied.text
    assert "ok" not in denied.json()
    ok = gated.get("/api/health", headers={BOOT_TOKEN_HEADER: secret})
    assert ok.status_code == 200
    assert ok.json() == {"ok": True}
    assert secret not in ok.text
    wrong = gated.get("/api/health", headers={BOOT_TOKEN_HEADER: "b" * 64})
    assert wrong.status_code == 401
    assert secret not in wrong.text


def test_cors_preflight_allows_only_listed_origins(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.setenv("PODCAST_REVIEW_CORS_ORIGINS", "https://review.example.test")
    client = TestClient(create_app())

    def preflight(origin: str) -> tuple[int, str | None]:
        res = client.options(
            "/api/health",
            headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
        )
        return res.status_code, res.headers.get("access-control-allow-origin")

    assert preflight("https://review.example.test") == (200, "https://review.example.test")
    assert preflight("http://127.0.0.1:5173") == (200, "http://127.0.0.1:5173")
    assert preflight("https://evil.example.test") == (400, None)
    assert preflight("https://review.example.test.evil.test") == (400, None)


_CORS_ENV = "PODCAST_REVIEW_CORS_ORIGINS"
_EVIL_ORIGIN = "https://evil.example"


def test_cors_wildcard_env_fails_closed_instead_of_reflecting_origin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.runtime_config import RuntimeConfigError

    monkeypatch.setenv(_CORS_ENV, "*")
    try:
        app = create_app()
    except RuntimeConfigError as exc:
        assert _CORS_ENV in str(exc)
        return
    client = TestClient(app)
    preflight = client.options(
        "/api/health",
        headers={"Origin": _EVIL_ORIGIN, "Access-Control-Request-Method": "GET"},
    )
    credentialed = client.get("/api/health", headers={"Origin": _EVIL_ORIGIN})
    pytest.fail(
        f"startup accepted {_CORS_ENV}='*' and reflected {_EVIL_ORIGIN}: "
        f"preflight allow-origin={preflight.headers.get('access-control-allow-origin')!r}, "
        f"credentialed allow-origin={credentialed.headers.get('access-control-allow-origin')!r}, "
        f"allow-credentials={credentialed.headers.get('access-control-allow-credentials')!r}"
    )


_DEFAULT_CORS_ORIGINS = [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://127.0.0.1:8765",
    "http://localhost:8765",
]


@pytest.mark.parametrize(
    "value",
    [
        "*",
        "https://ok.example,*",
        "https://*.example",
        "https://a.example/app",
        "https://a.example?x=1",
        "https://a.example#frag",
        "ftp://a.example",
        "http://a.example",
        "https://user:pw@a.example",
        "a.example",
    ],
)
def test_cors_origins_env_rejects_non_exact_origins(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    pytest.importorskip("fastapi")
    from podcast_mcp.gui.server import _cors_origins
    from podcast_mcp.runtime_config import RuntimeConfigError

    monkeypatch.setenv(_CORS_ENV, value)
    with pytest.raises(RuntimeConfigError, match=_CORS_ENV) as exc:
        _cors_origins()
    assert "pw" not in str(exc.value)


def test_cors_origins_env_normalizes_trailing_slash_case_and_default_port(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("fastapi")
    from podcast_mcp.gui.server import _cors_origins

    monkeypatch.setenv(
        _CORS_ENV,
        "https://A.example/, http://localhost:9000/ ,, https://b.example:8443,"
        " https://c.example:443, http://127.0.0.1:80",
    )
    assert _cors_origins() == [
        *_DEFAULT_CORS_ORIGINS,
        "https://a.example",
        "http://localhost:9000",
        "https://b.example:8443",
        "https://c.example",
        "http://127.0.0.1",
    ]


@pytest.mark.parametrize("value", [None, "", "  ", " , "])
def test_cors_origins_env_unset_or_blank_keeps_loopback_defaults(
    monkeypatch: pytest.MonkeyPatch, value: str | None
) -> None:
    pytest.importorskip("fastapi")
    from podcast_mcp.gui.server import _cors_origins

    if value is None:
        monkeypatch.delenv(_CORS_ENV, raising=False)
    else:
        monkeypatch.setenv(_CORS_ENV, value)
    assert _cors_origins() == _DEFAULT_CORS_ORIGINS


def test_cors_allows_only_listed_origins_with_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    monkeypatch.setenv(_CORS_ENV, "https://listed.example/")
    client = TestClient(create_app())

    def preflight(origin: str) -> dict[str, str | None]:
        res = client.options(
            "/api/health",
            headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
        )
        return {
            "origin": res.headers.get("access-control-allow-origin"),
            "credentials": res.headers.get("access-control-allow-credentials"),
        }

    assert preflight("https://listed.example") == {
        "origin": "https://listed.example",
        "credentials": "true",
    }
    assert preflight(_EVIL_ORIGIN)["origin"] is None
    refused = client.get("/api/health", headers={"Origin": _EVIL_ORIGIN})
    assert "access-control-allow-origin" not in refused.headers


@pytest.mark.parametrize("request_text", ["", "[]"])
def test_run_gui_server_refuses_invalid_editing_request_before_serving(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, request_text: str
) -> None:
    request = tmp_path / "editing-request.json"
    request.write_text(request_text, encoding="utf-8")
    monkeypatch.setenv("PODCAST_EDITING_BIND_REQUEST", str(request))
    monkeypatch.delenv(EPHEMERAL_ENV, raising=False)
    monkeypatch.delenv(LISTEN_FILE_ENV, raising=False)
    seen: dict[str, object] = {}
    _patch_uvicorn_server(monkeypatch, seen)
    with pytest.raises(ValueError, match=r"[Ee]diting"):
        run_gui_server(object(), host="127.0.0.1", port=0, log_level="warning")
    assert seen == {}
