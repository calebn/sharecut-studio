"""Host Streamable HTTP MCP on ``podcast gui`` (SDK ``/mcp``, not guest JSON-RPC)."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from podcast_mcp.gui.host_mcp import (
    HOST_MCP_PATH,
    NO_OPEN_PROJECT,
    host_mcp_lifespan,
)
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.share import ShareService

HANDSHAKE_VERSION = "2025-06-18"
MODERN_VERSION = "2026-07-28"
LOOPBACK_HOST = {"Host": "127.0.0.1:8765"}
MCP_ACCEPT = "application/json, text/event-stream"


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


def _parse_sse_json(text: str) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    data_lines: list[str] = []
    for line in text.splitlines():
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
        elif line == "" and data_lines:
            raw = "\n".join(data_lines)
            data_lines = []
            if raw.strip():
                messages.append(json.loads(raw))
    if data_lines:
        raw = "\n".join(data_lines)
        if raw.strip():
            messages.append(json.loads(raw))
    return messages


def _rpc_payload(response) -> dict[str, Any] | None:
    if response.status_code == 202:
        return None
    ctype = (response.headers.get("content-type") or "").lower()
    if "text/event-stream" in ctype:
        messages = _parse_sse_json(response.text)
        for msg in reversed(messages):
            if isinstance(msg, dict) and "id" in msg:
                return msg
        return messages[-1] if messages else {}
    if not response.content:
        return None
    return response.json()


def _post_mcp(
    client: TestClient,
    body: dict[str, Any],
    *,
    extra_headers: dict[str, str] | None = None,
    accept: str = MCP_ACCEPT,
) -> Any:
    headers = {
        "Accept": accept,
        "Content-Type": "application/json",
        **LOOPBACK_HOST,
    }
    if extra_headers:
        headers.update(extra_headers)
    return client.post(HOST_MCP_PATH, json=body, headers=headers)


def _initialize(client: TestClient) -> dict[str, Any]:
    res = _post_mcp(
        client,
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": HANDSHAKE_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "host-mcp-test", "version": "0"},
            },
        },
    )
    assert res.status_code == 200, res.text
    payload = _rpc_payload(res)
    assert payload is not None
    assert "mcp-session-id" not in res.headers
    initialized = _post_mcp(
        client,
        {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
    )
    assert initialized.status_code == 202, initialized.text
    assert "mcp-session-id" not in initialized.headers
    return payload


def test_host_mcp_handshake_lists_cut_words() -> None:
    pytest.importorskip("fastapi")
    with TestClient(create_app()) as client:
        payload = _initialize(client)
        result = payload["result"]
        assert result["protocolVersion"] in {
            HANDSHAKE_VERSION,
            "2025-11-25",
            "2025-03-26",
        }
        info = result["serverInfo"]
        assert info["name"] == "podcast-mcp"
        assert info["version"] == "0.1.0"

        listed = _post_mcp(
            client,
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        assert listed.status_code == 200, listed.text
        assert "mcp-session-id" not in listed.headers
        names = {t["name"] for t in _rpc_payload(listed)["result"]["tools"]}
        assert "cut_words_tool" in names
        assert "list_comments_tool" in names


def test_host_mcp_modern_discover() -> None:
    pytest.importorskip("fastapi")
    with TestClient(create_app()) as client:
        res = _post_mcp(
            client,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "server/discover",
                "params": {
                    "_meta": {
                        "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
                        "io.modelcontextprotocol/clientCapabilities": {},
                    }
                },
            },
            extra_headers={
                "MCP-Protocol-Version": MODERN_VERSION,
                "Mcp-Method": "server/discover",
            },
        )
        assert res.status_code in {200, 202}, res.text
        payload = _rpc_payload(res)
        assert payload is not None
        assert "error" not in payload
        assert "podcast-mcp" in json.dumps(payload["result"])


def test_host_mcp_accept_json_only_is_406() -> None:
    pytest.importorskip("fastapi")
    with TestClient(create_app()) as client:
        res = _post_mcp(
            client,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": HANDSHAKE_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "t", "version": "0"},
                },
            },
            accept="application/json",
        )
        assert res.status_code == 406, res.text


def test_host_mcp_rejects_get_and_head_without_opening_sse() -> None:
    pytest.importorskip("fastapi")
    with TestClient(create_app()) as client:
        for method in ("get", "head"):
            response = getattr(client, method)(HOST_MCP_PATH, headers=LOOPBACK_HOST)
            assert response.status_code == 405, response.text
            assert response.headers["allow"] == "POST"


def test_host_mcp_bad_origin_403() -> None:
    pytest.importorskip("fastapi")
    with TestClient(create_app()) as client:
        res = _post_mcp(
            client,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": HANDSHAKE_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "t", "version": "0"},
                },
            },
            extra_headers={"Origin": "https://evil.example"},
        )
        assert res.status_code == 403, res.text


def test_host_mcp_non_localhost_host_421() -> None:
    pytest.importorskip("fastapi")
    with TestClient(create_app()) as client:
        res = client.post(
            HOST_MCP_PATH,
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": HANDSHAKE_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "t", "version": "0"},
                },
            },
            headers={
                "Accept": MCP_ACCEPT,
                "Content-Type": "application/json",
                "Host": "evil.example",
            },
        )
        assert res.status_code == 421, res.text


def test_host_mcp_injects_open_project(minimal_project) -> None:
    pytest.importorskip("fastapi")
    with TestClient(create_app(served_project=minimal_project)) as client:
        _payload = _initialize(client)
        called = _post_mcp(
            client,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "list_comments_tool", "arguments": {}},
            },
        )
        assert called.status_code == 200, called.text
        assert "mcp-session-id" not in called.headers
        result = _rpc_payload(called)["result"]
        assert result.get("isError") is not True
        text = result["content"][0]["text"]
        listed = json.loads(text)
        assert listed == []

        foreign = _post_mcp(
            client,
            {
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "list_comments_tool",
                    "arguments": {"project_path": "/tmp/not-the-served.json"},
                },
            },
        )
        assert foreign.status_code == 200, foreign.text
        foreign_result = _rpc_payload(foreign)["result"]
        assert foreign_result.get("isError") is not True
        assert json.loads(foreign_result["content"][0]["text"]) == []

        skipped = _post_mcp(
            client,
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {"name": "not_a_real_tool", "arguments": {}},
            },
        )
        assert skipped.status_code == 200, skipped.text
        skipped_payload = _rpc_payload(skipped)
        assert skipped_payload is not None
        unknown = skipped_payload.get("error") or skipped_payload.get("result")
        assert unknown is not None


def test_host_mcp_shares_app_with_static_dir(tmp_path, minimal_project) -> None:
    pytest.importorskip("fastapi")
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "assets").mkdir()
    (dist / "index.html").write_text("<html><head></head></html>", encoding="utf-8")
    with TestClient(create_app(static_dir=dist, served_project=minimal_project)) as client:
        assert client.get("/").status_code == 200
        assert client.get("/favicon.svg").status_code == 404
        assert client.get("/favicon.ico").status_code == 404
        payload = _initialize(client)
        assert payload["result"]["serverInfo"]["name"] == "podcast-mcp"
        listed = _post_mcp(
            client,
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        names = {t["name"] for t in _rpc_payload(listed)["result"]["tools"]}
        assert "cut_words_tool" in names

    missing = tmp_path / "missing.json"
    with TestClient(create_app(static_dir=dist, served_project=missing)) as client:
        assert client.get("/").status_code == 200

    (dist / "favicon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>", encoding="utf-8")
    with TestClient(create_app(static_dir=dist)) as client:
        assert client.get("/favicon.svg").status_code == 200
        assert client.get("/favicon.ico").status_code == 200
        payload = _initialize(client)
        assert payload["result"]["serverInfo"]["name"] == "podcast-mcp"


def test_host_mcp_without_static_tree() -> None:
    pytest.importorskip("fastapi")
    missing = Path("/no-such-sharecut-gui-dist")
    with TestClient(create_app(static_dir=missing)) as client:
        payload = _initialize(client)
        assert payload["result"]["serverInfo"]["name"] == "podcast-mcp"


def test_review_spa_hook_error_falls_back(tmp_path, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html>fallback</html>", encoding="utf-8")

    from podcast_mcp.extensions.loader import load_extensions as real_load

    def boom(**_kwargs: object) -> str:
        raise RuntimeError("hook failed")

    def wrapped_load():
        reg = real_load()
        reg._spa_hooks[:] = [boom]
        return reg

    monkeypatch.setattr("podcast_mcp.gui.server.load_extensions", wrapped_load)
    monkeypatch.setattr(
        "podcast_mcp.services.share.lookup_share",
        lambda token, *, kind=None: {"token": token, "kind": kind or "review"},
    )
    with TestClient(create_app(static_dir=dist)) as client:
        res = client.get("/r/any-token")
        assert res.status_code == 200
        assert "fallback" in res.text


def test_host_mcp_errors_when_no_project_open() -> None:
    pytest.importorskip("fastapi")
    with TestClient(create_app(served_project=None)) as client:
        _payload = _initialize(client)
        called = _post_mcp(
            client,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "list_comments_tool", "arguments": {}},
            },
        )
        assert called.status_code == 200, called.text
        result = _rpc_payload(called)["result"]
        assert result.get("isError") is True
        assert NO_OPEN_PROJECT in result["content"][0]["text"]

        created = _post_mcp(
            client,
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "episode_create",
                    "arguments": {"workspace_dir": "/tmp/host-mcp-no-project"},
                },
            },
        )
        assert created.status_code == 200, created.text
        created_result = _rpc_payload(created)["result"]
        assert created_result.get("isError") is True
        assert NO_OPEN_PROJECT in created_result["content"][0]["text"]


def test_host_mcp_get_pins_served_project(minimal_project, monkeypatch) -> None:
    pytest.importorskip("fastapi")
    monkeypatch.setattr(
        "podcast_mcp.gui.routes.project.peer_host",
        lambda _request: "127.0.0.1",
    )
    with TestClient(create_app(served_project=None)) as client:
        loaded = client.get("/api/project", params={"path": str(minimal_project)})
        assert loaded.status_code == 200, loaded.text
        _payload = _initialize(client)
        called = _post_mcp(
            client,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "list_comments_tool", "arguments": {}},
            },
        )
        assert called.status_code == 200, called.text
        result = _rpc_payload(called)["result"]
        assert result.get("isError") is not True


def test_host_mcp_skipped_off_loopback_bind() -> None:
    pytest.importorskip("fastapi")
    with TestClient(create_app(bind_host="0.0.0.0")) as client:
        res = client.post(
            HOST_MCP_PATH,
            json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            headers={"Accept": MCP_ACCEPT, "Content-Type": "application/json"},
        )
        assert res.status_code == 404


def test_host_mcp_session_manager_is_stateless_and_stays_on_app() -> None:
    pytest.importorskip("fastapi")
    app_a = create_app()
    manager_a = app_a.state.host_mcp_session_manager
    app_b = create_app()
    manager_b = app_b.state.host_mcp_session_manager
    assert manager_a is not None
    assert manager_b is not None
    assert manager_a is not manager_b
    assert manager_a.stateless is True
    assert manager_b.stateless is True
    with TestClient(app_a) as client:
        payload = _initialize(client)
        assert payload["result"]["serverInfo"]["name"] == "podcast-mcp"


def test_host_mcp_lifespan_runs_the_captured_manager() -> None:
    class TrackingManager:
        def __init__(self) -> None:
            self.entered = False
            self.exited = False

        @asynccontextmanager
        async def run(self):
            self.entered = True
            try:
                yield
            finally:
                self.exited = True

    app = FastAPI()
    manager = TrackingManager()
    app.state.host_mcp_session_manager = manager

    async def exercise_lifespan() -> None:
        async with host_mcp_lifespan(app):
            assert manager.entered is True
            assert manager.exited is False

    asyncio.run(exercise_lifespan())
    assert manager.exited is True


def test_guest_mcp_token_path_unchanged(
    minimal_project, sample_wav, tmp_workspace, monkeypatch
) -> None:
    pytest.importorskip("fastapi")
    ws = _seed_premix(minimal_project, sample_wav)
    index = tmp_workspace / "shares_index.json"
    monkeypatch.setenv("PODCAST_REVIEW_SHARES_INDEX", str(index))
    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    ver = ReviewService(ws).publish(label="mcp-host-reg")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        public_base_url="https://share.example",
        capabilities=["play", "comment", "mcp"],
    )
    token = share["token"]
    with TestClient(create_app()) as client:
        info = client.get(f"/mcp/{token}")
        assert info.status_code == 200, info.text
        assert info.json()["mcp_path"] == f"/mcp/{token}/mcp"
        init = client.post(
            f"/mcp/{token}/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "t", "version": "0"},
                },
            },
        )
        assert init.status_code == 200, init.text
        tools = client.post(
            f"/mcp/{token}/mcp",
            json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        names = {t["name"] for t in tools.json()["result"]["tools"]}
        assert "guest_add_comment" in names
        assert "cut_words_tool" not in names


def test_host_project_injection_helpers() -> None:
    from podcast_mcp.gui import host_mcp

    host_mcp.install_host_project_injection()
    host_mcp.install_host_project_injection()
    assert host_mcp._tool_accepts_project_path("list_comments_tool")
    assert not host_mcp._tool_accepts_project_path("episode_create")
    assert not host_mcp._tool_accepts_project_path("not_a_real_tool")
