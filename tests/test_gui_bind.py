"""Exclusive GUI bind, listen file, and boot-token health."""

from __future__ import annotations

import os
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


def test_run_gui_server_without_listen_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(LISTEN_FILE_ENV, raising=False)
    monkeypatch.delenv(EPHEMERAL_ENV, raising=False)
    seen: dict[str, object] = {}
    _patch_uvicorn_server(monkeypatch, seen)
    app = object()
    run_gui_server(app, host="127.0.0.1", port=0, log_level="warning")
    assert seen["app"] is app
    sockets = seen["sockets"]
    assert isinstance(sockets, list) and len(sockets) == 1
    assert "fd" not in seen


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
