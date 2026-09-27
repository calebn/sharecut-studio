"""Shared guest WebSocket admission helpers: token, concurrency gate, guard lifecycle."""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from podcast_mcp.gui.routes import guest_ws_common as gwc
from podcast_mcp.gui.routes.guest_ws_common import (
    GUEST_WS_CONCURRENCY_REASON,
    GUEST_WS_INVALID_TOKEN_REASON,
    admit_guest_ws,
    guest_ws_share_row,
)
from podcast_mcp.gui.server import create_app
from podcast_mcp.models import load_project, save_project
from podcast_mcp.services import ProjectWorkspace, ReviewService
from podcast_mcp.services.remote_mcp.limits import reset_host_limiters_for_tests
from podcast_mcp.services.share import ShareService


def _seed_premix(minimal_project, sample_wav):
    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    return ProjectWorkspace.open(minimal_project)


class _Ws:
    def __init__(self) -> None:
        self.accepted = False
        self.closed: list[tuple[int, str]] = []
        self.sent: list[dict] = []
        self.headers: dict[str, str] = {}

    async def accept(self) -> None:
        self.accepted = True

    async def close(self, code: int, reason: str) -> None:
        self.closed.append((code, reason))

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


@pytest.mark.asyncio
async def test_guest_ws_share_row_rejects_unknown_token():
    ws = _Ws()
    row = await guest_ws_share_row(ws, "no-such-token", kind="review")
    assert row is None
    assert ws.closed == [(4403, GUEST_WS_INVALID_TOKEN_REASON)]


@pytest.mark.asyncio
async def test_guest_ws_share_row_returns_row(monkeypatch):
    monkeypatch.setattr(gwc, "lookup_share", lambda tok, kind=None: {"token": tok})
    ws = _Ws()
    row = await guest_ws_share_row(ws, "tok", kind="review")
    assert row == {"token": "tok"}
    assert ws.closed == []


@pytest.mark.asyncio
async def test_admit_guest_ws_rate_limit_disabled(monkeypatch):
    monkeypatch.setattr(gwc, "host_rate_limit_enabled", lambda: False)

    def _boom():
        raise AssertionError("limiters must not be touched")

    monkeypatch.setattr(gwc, "get_host_limiters", _boom)
    ws = _Ws()
    conn = await admit_guest_ws(ws, "tok", log_label="test")
    assert conn is not None
    conn.release()


@pytest.mark.asyncio
async def test_admit_guest_ws_rejects_when_full(monkeypatch):
    monkeypatch.setenv("PODCAST_GUEST_WS_CONCURRENT", "1")
    reset_host_limiters_for_tests()
    lim = gwc.get_host_limiters()
    assert lim.guest_ws_concurrent.try_enter("tok").allowed
    try:
        ws = _Ws()
        conn = await admit_guest_ws(ws, "tok", log_label="test")
        assert conn is None
        assert ws.closed == [(4429, GUEST_WS_CONCURRENCY_REASON)]
    finally:
        lim.guest_ws_concurrent.exit("tok")
        reset_host_limiters_for_tests()


@pytest.mark.asyncio
async def test_admit_guest_ws_release_is_idempotent(monkeypatch):
    monkeypatch.setenv("PODCAST_GUEST_WS_CONCURRENT", "1")
    reset_host_limiters_for_tests()
    try:
        ws = _Ws()
        conn = await admit_guest_ws(ws, "tok", log_label="test")
        assert conn is not None
        conn.release()
        conn.release()
        lim = gwc.get_host_limiters()
        assert lim.guest_ws_concurrent.try_enter("tok").allowed
        lim.guest_ws_concurrent.exit("tok")
    finally:
        reset_host_limiters_for_tests()


@pytest.mark.asyncio
async def test_start_accepts_and_rechecks(monkeypatch):
    monkeypatch.setattr(gwc, "host_rate_limit_enabled", lambda: False)
    monkeypatch.setattr(gwc, "GUEST_SHARE_RECHECK_S", 0.01)
    ws = _Ws()
    conn = await admit_guest_ws(ws, "tok", log_label="test")
    assert conn is not None
    guard = await conn.start(lambda: False)
    assert ws.accepted is True
    await asyncio.sleep(0.05)
    assert (4403, "share revoked or expired") in ws.closed
    assert guard.closed is True
    await conn.stop_tasks()


@pytest.mark.asyncio
async def test_start_passes_send_gate(monkeypatch):
    monkeypatch.setattr(gwc, "host_rate_limit_enabled", lambda: False)
    ws = _Ws()
    conn = await admit_guest_ws(ws, "tok", log_label="test")
    assert conn is not None
    guard = await conn.start(lambda: True, send_gate=lambda: False)
    try:
        await guard.send_json({"hello": "guest"})
        assert (4403, "participant removed") in ws.closed
        assert ws.sent == []
    finally:
        await conn.stop_tasks()


@pytest.mark.asyncio
async def test_stop_tasks_cancels_and_logs_failures(caplog):
    ws = _Ws()
    conn = await admit_guest_ws(ws, "tok", log_label="test")
    assert conn is not None

    async def _sleeper() -> None:
        await asyncio.sleep(10)

    async def _boom() -> None:
        raise RuntimeError("boom")

    sleeper_task = conn.spawn(_sleeper())
    conn.spawn(_boom())
    await asyncio.sleep(0)

    with caplog.at_level(logging.ERROR):
        await conn.stop_tasks()
    assert sleeper_task.cancelled()
    assert any("pump exit" in rec.message for rec in caplog.records)

    # A second call is a no-op — nothing left to cancel, nothing new logged.
    caplog.clear()
    await conn.stop_tasks()
    assert caplog.records == []


GUEST_WS_PATHS = (
    "/api/review/{token}/daw/ws",
    "/api/review/{token}/progress/ws",
    "/api/rec/{token}/ws",
)


@pytest.mark.parametrize("path", GUEST_WS_PATHS)
def test_guest_sockets_reject_unknown_token_identically(path, tmp_workspace):
    client = TestClient(create_app())
    with client.websocket_connect(path.format(token="no-such-token")) as sock:
        payload = sock.receive()
    assert payload["type"] == "websocket.close"
    assert (payload["code"], payload["reason"]) == (4403, GUEST_WS_INVALID_TOKEN_REASON)


@pytest.mark.parametrize("path", GUEST_WS_PATHS)
def test_guest_sockets_reject_revoked_token_identically(path, minimal_project, sample_wav):
    ws = _seed_premix(minimal_project, sample_wav)
    ver = ReviewService(ws).publish(label="RevokedParity")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view"],
    )
    token = share["token"]
    ShareService(ws).revoke(token)

    client = TestClient(create_app())
    with client.websocket_connect(path.format(token=token)) as sock:
        payload = sock.receive()
    assert payload["type"] == "websocket.close"
    assert (payload["code"], payload["reason"]) == (4403, GUEST_WS_INVALID_TOKEN_REASON)
