"""Relay caps: shares, monthly bytes, byte rate, idle cutoff, the legacy tier and the notice."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import re
import sqlite3
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from tests.polling import until
from tests.relay_enroll import enable_enrollment
from tests.relay_live import live_relay
from websockets.exceptions import ConnectionClosed
from websockets.sync.client import ClientConnection
from websockets.sync.client import connect as ws_connect

from podcast_mcp.util.relay_protocol.share_claims import attach_share_claims
from podcast_relay.app import create_relay_app
from podcast_relay.caps import ByteBucket, Tier, load_caps_config
from podcast_relay.routes.tunnel import _ingest_http_response
from podcast_relay.state import TunnelSession
from podcast_relay.usage import UsageLedger, current_period

LEGACY_SECRET = "legacy-secret-" + "x" * 20
PAGE = b"<html><body>hi</body></html>"
NAVIGATE = {"sec-fetch-mode": "navigate", "sec-fetch-dest": "document"}
SAME_ORIGIN = {"sec-fetch-site": "same-origin"}


@pytest.fixture(autouse=True)
def _unlimited_rate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_RELAY_RATE_LIMIT", "0")


class FakeHost:
    """A host websocket that answers every ``http`` frame with a fixed response."""

    def __init__(self, *, body: bytes = PAGE, content_type: str = "text/html") -> None:
        self.session: TunnelSession | None = None
        self.body = body
        self.content_type = content_type
        self.sent: list[dict[str, Any]] = []
        self.closed: list[tuple[int, str]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        self.sent.append(data)
        if data["type"] == "http" and self.session is not None:
            await _ingest_http_response(
                self.session.pending[data["id"]],
                {
                    "status": 200,
                    "headers": {"Content-Type": self.content_type},
                    "body_b64": base64.b64encode(self.body).decode(),
                    "eof": True,
                },
            )

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed.append((code, reason))


async def host_session(
    app: FastAPI,
    *,
    install_id: str = "",
    host_id: str = "h1",
    tokens: tuple[str, ...] = ("tok",),
    host: FakeHost | None = None,
    client_ip: str = "198.51.100.7",
) -> TunnelSession:
    state = app.state.relay
    host = host or FakeHost()
    meter = state.meter.session(
        install_id=install_id, host_token="" if install_id else LEGACY_SECRET, client_ip=client_ip
    )
    session = TunnelSession(
        host_id=host_id,
        websocket=host,  # type: ignore[arg-type]
        host_token="" if install_id else LEGACY_SECRET,
        install_id=install_id,
        meter=meter,
    )
    host.session = session
    await state.register_tunnel(session)
    secret = state.policy.claim_key(install_id) if install_id else LEGACY_SECRET
    rows = attach_share_claims(
        [{"token": t, "capabilities": ["view", "play"]} for t in tokens],
        host_id=host_id,
        secret=secret,
    )
    await state.update_shares(host_id, rows, expected_session=session)
    return session


def signing_relay(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, **env: str) -> FastAPI:
    enable_enrollment(monkeypatch, tmp_path, PODCAST_RELAY_HOST_TOKENS=LEGACY_SECRET, **env)
    return create_relay_app()


def visible_text(page: str) -> str:
    return re.sub(r"<style>.*?</style>", "", page, flags=re.S).lower()


def client(app: FastAPI) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="https://relay.test")


class _FailingOnce:
    """A sqlite connection whose first executemany fails, then behaves."""

    def __init__(self, db) -> None:
        self._db = db
        self.failed = False

    def executemany(self, *args):
        if not self.failed:
            self.failed = True
            raise sqlite3.OperationalError("database is locked")
        return self._db.executemany(*args)

    def __getattr__(self, name):
        return getattr(self._db, name)


def test_a_failed_flush_keeps_the_counters_for_the_next_one(tmp_path: Path) -> None:
    path = tmp_path / "usage.sqlite3"
    ledger = UsageLedger(path)
    ledger._db = _FailingOnce(ledger._db)
    ledger.add("install:a", 7)

    with pytest.raises(sqlite3.OperationalError):
        ledger.flush()
    ledger.flush()
    ledger.close()

    assert UsageLedger(path).used("install:a") == 7


@pytest.mark.asyncio
async def test_the_usage_flush_loop_keeps_running_after_a_failed_write() -> None:
    from podcast_relay.app import flush_usage_every

    class Ledger:
        calls = 0

        def flush(self) -> None:
            self.calls += 1
            if self.calls == 1:
                raise sqlite3.OperationalError("disk I/O error")

    ledger = Ledger()
    task = asyncio.create_task(flush_usage_every(ledger, 0.01))  # type: ignore[arg-type]
    try:
        await until(lambda: ledger.calls >= 3)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    assert ledger.calls >= 3


def test_the_ledger_counts_per_key_and_a_new_month_starts_at_zero() -> None:
    now = [time.mktime((2026, 11, 30, 12, 0, 0, 0, 0, 0))]
    ledger = UsageLedger(clock=lambda: now[0])
    ledger.add("install:a", 10)
    ledger.add("install:a", 5)
    ledger.add("install:b", 1)

    assert (ledger.used("install:a"), ledger.used("install:b")) == (15, 1)

    now[0] += 7 * 24 * 3600
    assert (ledger.used("install:a"), ledger.used("install:b")) == (0, 0)


def test_the_ledger_file_keeps_the_month_across_a_restart_and_drops_old_months(
    tmp_path: Path,
) -> None:
    path = tmp_path / "state" / "usage.sqlite3"
    now = [1_000_000_000.0]
    first = UsageLedger(path, clock=lambda: now[0])
    first.add("install:a", 42)
    first.close()

    again = UsageLedger(path, clock=lambda: now[0])
    assert again.used("install:a") == 42
    again.close()

    now[0] += 40 * 24 * 3600
    later = UsageLedger(path, clock=lambda: now[0])
    assert later.used("install:a") == 0
    later.close()
    assert UsageLedger(path, clock=lambda: now[0]).used("install:a") == 0
    assert current_period(1_000_000_000.0) == "2001-09"


def test_a_byte_bucket_asks_for_a_wait_only_after_its_burst() -> None:
    clock = [0.0]
    bucket = ByteBucket(1000, clock=lambda: clock[0])
    burst = bucket.burst

    assert bucket.reserve(burst) == 0.0
    assert bucket.reserve(1000) == pytest.approx(1.0)
    clock[0] += 5.0
    assert bucket.reserve(0) == 0.0


def test_the_defaults_are_five_shares_twenty_gigabytes_and_two_minutes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in (
        "PODCAST_RELAY_INSTALL_MAX_SHARES",
        "PODCAST_RELAY_INSTALL_MONTHLY_BYTES",
        "PODCAST_RELAY_IDLE_SEC",
        "PODCAST_RELAY_LEGACY_MAX_SHARES",
        "PODCAST_RELAY_LEGACY_MONTHLY_BYTES",
        "PODCAST_RELAY_LEGACY_TIER",
    ):
        monkeypatch.delenv(name, raising=False)

    cfg = load_caps_config()

    assert (cfg.lease.max_shares, cfg.lease.monthly_bytes, cfg.idle_sec) == (5, 20_000_000_000, 120)
    assert (cfg.legacy.max_shares, cfg.legacy.monthly_bytes) == (1, 2_000_000_000)
    assert cfg.legacy_enabled


@pytest.mark.asyncio
async def test_a_sixth_share_is_refused_and_the_host_is_told(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path)
    state = app.state.relay
    session = await host_session(app, install_id="i1", tokens=("a", "b", "c", "d", "e"))
    secret = state.policy.claim_key("i1")

    rows = attach_share_claims(
        [{"token": t, "capabilities": ["view"]} for t in ("new", "a", "b", "c", "d", "e")],
        host_id="h1",
        secret=secret,
    )
    await state.update_shares("h1", rows, expected_session=session)

    assert session.share_tokens == {"a", "b", "c", "d", "e"}
    assert session.refused_shares == 1
    assert state.limit_kind(session) == "shares"
    assert state.tunnel_for_token("new") is None


@pytest.mark.asyncio
async def test_registering_within_the_cap_clears_the_share_limit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path, PODCAST_RELAY_INSTALL_MAX_SHARES="1")
    session = await host_session(app, install_id="i1", tokens=("a", "b"))
    assert session.refused_shares == 1

    rows = attach_share_claims(
        [{"token": "a", "capabilities": ["view"]}],
        host_id="h1",
        secret=app.state.relay.policy.claim_key("i1"),
    )
    await app.state.relay.update_shares("h1", rows, expected_session=session)

    assert app.state.relay.limit_kind(session) == ""


def test_the_register_ack_names_the_limit(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from fastapi.testclient import TestClient
    from tests.relay_enroll import enroll_body

    app = signing_relay(monkeypatch, tmp_path, PODCAST_RELAY_INSTALL_MAX_SHARES="2")
    http = TestClient(app)
    grant = http.post("/enroll", json=enroll_body()).json()
    shares = attach_share_claims(
        [{"token": t, "capabilities": ["view"]} for t in ("a", "b", "c")],
        host_id=grant["install_id"],
        secret=grant["claim_key"],
    )

    with http.websocket_connect("/tunnel") as ws:
        ws.send_json({"type": "hello", "host_id": grant["install_id"], "lease": grant["lease"]})
        ws.receive_json()
        ws.send_json({"type": "register", "shares": shares})
        ack = ws.receive_json()

    assert ack == {
        "type": "register",
        "ok": True,
        "share_count": 2,
        "limited": "shares",
        "refused": 1,
    }


@pytest.mark.asyncio
async def test_proxied_bytes_count_both_ways_and_the_cap_pauses_the_link(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path, PODCAST_RELAY_INSTALL_MONTHLY_BYTES="100")
    session = await host_session(app, install_id="i1", host=FakeHost(body=b"x" * 60))
    ledger = app.state.relay.meter.ledger
    async with client(app) as http:
        first = await http.post("/r/tok/x", content=b"y" * 30)
        assert (first.status_code, len(first.content)) == (200, 60)
        assert ledger.used("install:i1") == 90

        second = await http.get("/r/tok/x")
        assert second.status_code == 200
        assert second.content == b""

        paused = await http.get("/r/tok/x", headers=NAVIGATE)
        api = await http.get("/api/review/tok/state")

    assert paused.status_code == 503
    assert "paused for now" in paused.text
    assert not any(
        word in visible_text(paused.text) for word in ("tunnel", "relay", "lease", "token")
    )
    assert api.status_code == 503
    assert api.json()["detail"] == "sharing paused"
    for response in (paused, api):
        assert response.headers["retry-after"] == "3600"
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-robots-tag"] == "noindex"
    assert (await asyncio.wait_for(session.to_host.get(), 1)) == {
        "type": "limit",
        "kind": "bandwidth",
    }


@pytest.mark.asyncio
async def test_the_next_month_lifts_the_pause_and_tells_the_host(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path, PODCAST_RELAY_INSTALL_MONTHLY_BYTES="100")
    session = await host_session(app, install_id="i1")
    state = app.state.relay
    now = [1_000_000_000.0]
    state.meter.ledger.clock = lambda: now[0]
    state.meter.ledger.add("install:i1", 100)
    async with client(app) as http:
        assert (await http.get("/r/tok/x")).status_code == 503
        await asyncio.wait_for(session.to_host.get(), 1)

        now[0] += 40 * 24 * 3600
        assert (await http.get("/r/tok/x")).status_code == 200

    assert (await asyncio.wait_for(session.to_host.get(), 1)) == {"type": "limit", "kind": ""}


@pytest.mark.asyncio
async def test_a_denied_install_s_link_shows_the_offline_page(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path)
    session = await host_session(app, install_id="i1")
    await app.state.relay.unregister_tunnel("h1", expected_session=session)
    async with client(app) as http:
        res = await http.get("/r/tok/", headers=NAVIGATE)

    assert res.status_code == 503
    assert "Host offline" in res.text


@pytest.mark.asyncio
async def test_a_stream_with_no_traffic_for_the_idle_time_ends(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path, PODCAST_RELAY_IDLE_SEC="0.2")
    session = await host_session(app, install_id="i1")

    async def stall(data: dict[str, Any]) -> None:
        await _ingest_http_response(
            session.pending[data["id"]],
            {
                "status": 200,
                "headers": {"Content-Type": "audio/mpeg"},
                "body_b64": "YWJj",
                "eof": False,
            },
        )

    session.websocket.send_json = stall  # type: ignore[method-assign,union-attr]
    started = time.monotonic()
    async with client(app) as http:
        res = await http.get("/api/review/tok/audio")

    assert res.content == b"abc"
    assert time.monotonic() - started < 3
    assert session.pending == {}


@pytest.mark.asyncio
async def test_the_session_rate_paces_a_response(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path)
    session = await host_session(app, install_id="i1")
    naps: list[float] = []

    async def record_nap(seconds: float) -> None:
        naps.append(seconds)

    meter = session.meter
    assert meter is not None
    meter.sleep = record_nap
    meter.session_bucket = ByteBucket(1000, clock=lambda: 0.0)
    await meter.pace(meter.session_bucket.burst)
    await meter.pace(2000)

    assert naps == [pytest.approx(2.0)]


@pytest.mark.asyncio
async def test_the_relay_wide_rate_is_shared_by_every_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path)
    one = await host_session(app, install_id="i1", host_id="i1")
    two = await host_session(app, install_id="i2", host_id="i2", tokens=("tok2",))

    assert one.meter is not None and two.meter is not None
    assert one.meter.global_bucket is two.meter.global_bucket
    assert one.meter.session_bucket is not two.meter.session_bucket


@pytest.mark.asyncio
async def test_a_legacy_host_gets_one_share_and_a_small_allowance(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path, PODCAST_RELAY_LEGACY_MONTHLY_BYTES="50")
    session = await host_session(app, host_id="old-host", tokens=("a", "b"))

    assert session.meter is not None and session.meter.tier is Tier.LEGACY
    assert session.share_tokens == {"a"}
    assert app.state.relay.limit_kind(session) == "shares"
    async with client(app) as http:
        assert (await http.post("/r/a/x", content=b"z" * 60)).status_code == 200
        assert (await http.get("/r/a/x")).status_code == 503


@pytest.mark.asyncio
async def test_legacy_hosts_behind_one_address_share_a_cap(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path, PODCAST_RELAY_LEGACY_IP_MONTHLY_BYTES="50")
    await host_session(app, host_id="h1", tokens=("a",), client_ip="203.0.113.9")
    await host_session(app, host_id="h2", tokens=("b",), client_ip="203.0.113.9")
    await host_session(app, host_id="h3", tokens=("c",), client_ip="203.0.113.10")
    async with client(app) as http:
        await http.post("/r/a/x", content=b"z" * 60)

        assert (await http.get("/r/b/x")).status_code == 503
        assert (await http.get("/r/c/x")).status_code == 200


@pytest.mark.asyncio
async def test_a_legacy_token_has_one_allowance_whatever_host_ids_it_presents(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path, PODCAST_RELAY_LEGACY_MONTHLY_BYTES="50")
    await host_session(app, host_id="h1", tokens=("a",))
    await host_session(app, host_id="h2-fresh-id", tokens=("b",))
    async with client(app) as http:
        await http.post("/r/a/x", content=b"z" * 60)

        assert (await http.get("/r/b/x")).status_code == 503


def _legacy_hello(ws, host_id: str) -> dict[str, Any]:
    ws.send_json({"type": "hello", "host_id": host_id, "host_token": LEGACY_SECRET})
    return ws.receive_json()


def test_a_legacy_token_cannot_hold_more_than_its_tunnel_limit(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    app = signing_relay(monkeypatch, tmp_path, PODCAST_RELAY_LEGACY_MAX_TUNNELS="2")
    http = TestClient(app)
    with (
        http.websocket_connect("/tunnel") as one,
        http.websocket_connect("/tunnel") as two,
        http.websocket_connect("/tunnel") as three,
    ):
        assert _legacy_hello(one, "a")["ok"] is True
        assert _legacy_hello(two, "b")["ok"] is True
        refused = _legacy_hello(three, "c")
        with pytest.raises(WebSocketDisconnect) as closed:
            three.receive_json()

    assert refused["type"] == "error" and "rate limit exceeded" in refused["detail"]
    assert closed.value.code == 4429


def test_a_legacy_hello_naming_a_denied_install_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    app = signing_relay(monkeypatch, tmp_path)
    app.state.relay.policy.deny = frozenset({"banned-install"})
    with TestClient(app).websocket_connect("/tunnel") as ws:
        reply = _legacy_hello(ws, "banned-install")
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()

    assert reply == {"type": "error", "detail": "lease_refused:denied"}
    assert closed.value.code == 4403


@pytest.mark.asyncio
async def test_denying_an_id_closes_a_legacy_tunnel_that_presented_it(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path)
    host = FakeHost()
    await host_session(app, host_id="banned-install", host=host)

    await app.state.relay.close_denied(frozenset({"banned-install"}))

    assert host.closed == [(4403, "install denied")]


def test_ending_the_legacy_tier_refuses_a_host_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    app = signing_relay(monkeypatch, tmp_path, PODCAST_RELAY_LEGACY_TIER="0")
    with TestClient(app).websocket_connect("/tunnel") as ws:
        ws.send_json({"type": "hello", "host_id": "old", "host_token": LEGACY_SECRET})
        assert ws.receive_json() == {"type": "error", "detail": "legacy_tier_ended"}
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 4403


def test_a_relay_with_no_signing_key_has_no_caps_and_no_notice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PODCAST_RELAY_SIGNING_KEY", raising=False)
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", LEGACY_SECRET)
    app = create_relay_app()
    state = app.state.relay

    async def scenario() -> tuple[int, str, set[str]]:
        host = FakeHost()
        session = TunnelSession(host_id="h1", websocket=host, host_token=LEGACY_SECRET)  # type: ignore[arg-type]
        host.session = session
        await state.register_tunnel(session)
        tokens = tuple(f"tok{n}" for n in range(8))
        rows = attach_share_claims(
            [{"token": t, "capabilities": ["view"]} for t in tokens],
            host_id="h1",
            secret=LEGACY_SECRET,
        )
        await state.update_shares("h1", rows, expected_session=session)
        async with client(app) as http:
            res = await http.get("/r/tok0/", headers=NAVIGATE)
        return res.status_code, res.text, session.share_tokens

    status, text, shares = asyncio.run(scenario())

    assert state.meter is None
    assert (status, text) == (200, PAGE.decode())
    assert len(shares) == 8


@pytest.mark.asyncio
async def test_a_guest_of_a_legacy_host_sees_the_notice_once_per_browser_session(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path)
    await host_session(app, host_id="old-host")
    async with client(app) as http:
        first = await http.get("/r/tok/?t=12", headers=NAVIGATE)
        assert first.status_code == 200
        assert "This link is shared through ShareCut" in first.text
        assert "<button" in first.text and "Continue" in first.text
        assert first.headers["cache-control"] == "no-store"
        assert PAGE.decode() not in first.text

        passed = await http.post(
            "/notice/continue?next=%2Fr%2Ftok%2F%3Ft%3D12", headers=SAME_ORIGIN
        )
        assert passed.status_code == 303
        assert passed.headers["location"] == "/r/tok/?t=12"
        cookie = passed.headers["set-cookie"]
        assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Secure" in cookie
        assert "Max-Age" not in cookie and "expires" not in cookie.lower()

        second = await http.get("/r/tok/?t=12", headers=NAVIGATE)

    assert second.text == PAGE.decode()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path", "headers"),
    [
        ("GET", "/r/tok/assets/app.js", {"sec-fetch-mode": "no-cors", "sec-fetch-dest": "script"}),
        ("GET", "/r/tok/", {"sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe"}),
        ("GET", "/r/tok/", {"sec-fetch-mode": "cors", "sec-fetch-dest": "empty"}),
        ("GET", "/api/review/tok/state", NAVIGATE),
        ("GET", "/mcp/tok", NAVIGATE),
        ("GET", "/api/rec/tok/state", NAVIGATE),
        ("POST", "/r/tok/", NAVIGATE),
        ("GET", "/r/tok/", {"accept": "audio/mpeg"}),
    ],
)
async def test_only_a_top_level_page_navigation_gets_the_notice(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    method: str,
    path: str,
    headers: dict[str, str],
) -> None:
    app = signing_relay(monkeypatch, tmp_path)
    session = await host_session(app, host_id="old-host")
    session.capabilities["tok"] = ["view", "mcp"]
    async with client(app) as http:
        res = await http.request(method, path, headers=headers)

    assert "shared through ShareCut" not in res.text


@pytest.mark.asyncio
async def test_a_browser_without_fetch_metadata_is_judged_by_accept(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path)
    await host_session(app, host_id="old-host")
    async with client(app) as http:
        page = await http.get("/rec/tok/", headers={"accept": "text/html,*/*;q=0.8"})

    assert "shared through ShareCut" in page.text


@pytest.mark.asyncio
async def test_an_enrolled_install_s_guests_never_see_the_notice(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path)
    await host_session(app, install_id="i1")
    async with client(app) as http:
        res = await http.get("/r/tok/", headers=NAVIGATE)

    assert res.text == PAGE.decode()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "target",
    ["https://evil.test/", "//evil.test/r/x", "/other", "/r//evil.test", "/r/x\\y", "/r/x\n", ""],
)
async def test_continue_only_returns_to_a_link_page(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, target: str
) -> None:
    from urllib.parse import quote

    app = signing_relay(monkeypatch, tmp_path)
    async with client(app) as http:
        res = await http.post(
            f"/notice/continue?next={quote(target, safe='')}", headers=SAME_ORIGIN
        )

    assert res.status_code == 404
    assert "set-cookie" not in res.headers


@pytest.mark.asyncio
async def test_a_relay_with_no_signing_key_has_no_continue_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PODCAST_RELAY_SIGNING_KEY", raising=False)
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", LEGACY_SECRET)
    async with client(create_relay_app()) as http:
        res = await http.post("/notice/continue?next=%2Fr%2Fx", headers=SAME_ORIGIN)

    assert res.status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "headers",
    [
        {"sec-fetch-site": "cross-site"},
        {"sec-fetch-site": "same-site"},
        {"sec-fetch-site": "none"},
        {"origin": "https://evil.test"},
        {"origin": "null"},
        {},
    ],
)
async def test_another_site_cannot_post_the_continue_cookie_onto_a_visitor(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, headers: dict[str, str]
) -> None:
    app = signing_relay(monkeypatch, tmp_path)
    async with client(app) as http:
        res = await http.post("/notice/continue?next=%2Fr%2Ftok%2F", headers=headers)

    assert res.status_code == 403
    assert "set-cookie" not in res.headers


@pytest.mark.asyncio
async def test_a_browser_that_sends_only_origin_may_continue_from_the_same_origin(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path)
    async with client(app) as http:
        res = await http.post(
            "/notice/continue?next=%2Fr%2Ftok%2F", headers={"origin": "https://relay.test"}
        )

    assert res.status_code == 303


def test_the_notice_page_follows_the_brand_page_and_the_copy_rules() -> None:
    from fastapi import Request

    from podcast_relay.notice import notice_response

    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/r/tok/",
            "query_string": b"",
            "headers": [],
            "scheme": "https",
            "server": ("relay.test", 443),
        }
    )
    text = bytes(notice_response(request).body).decode()

    assert "var(--color-accent-solid)" in text and "--color-bg-canvas" in text
    assert '<html lang="en">' in text
    assert '<meta name="viewport" content="width=device-width, initial-scale=1"/>' in text
    assert "min-block-size: var(--tap-comfortable)" in text
    assert "--tap-comfortable: 2.75rem" in text
    assert not any(word in visible_text(text) for word in ("tunnel", "relay", "lease", "token"))
    assert "\u2014" not in visible_text(text)


@contextlib.contextmanager
def _live_legacy_tunnel(base: str, token: str) -> Iterator[ClientConnection]:
    """A legacy-tier host on a live relay, advertising one view share."""
    with ws_connect(f"{base}/tunnel", open_timeout=5, close_timeout=5) as tunnel:
        tunnel.send(json.dumps({"type": "hello", "host_token": LEGACY_SECRET, "host_id": "old"}))
        assert json.loads(tunnel.recv(timeout=5))["ok"] is True
        shares = attach_share_claims(
            [{"token": token, "capabilities": ["view"]}], host_id="old", secret=LEGACY_SECRET
        )
        tunnel.send(json.dumps({"type": "register", "shares": shares}))
        assert json.loads(tunnel.recv(timeout=5))["ok"] is True
        yield tunnel


def test_a_guest_socket_with_no_traffic_is_closed_at_the_idle_time(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path, PODCAST_RELAY_IDLE_SEC="0.3")
    with live_relay(monkeypatch, host_token=LEGACY_SECRET, app=app) as base:
        with (
            _live_legacy_tunnel(base, "gtok") as tunnel,
            ws_connect(f"{base}/api/review/gtok/daw/ws", open_timeout=5) as guest,
        ):
            opened = json.loads(tunnel.recv(timeout=5))
            assert opened["type"] == "ws_open"
            started = time.monotonic()
            with pytest.raises(ConnectionClosed) as closed:
                guest.recv(timeout=5)

    assert closed.value.rcvd is not None
    assert (closed.value.rcvd.code, closed.value.rcvd.reason) == (1001, "idle")
    assert time.monotonic() - started < 3


def test_a_guest_socket_counts_both_directions_and_closes_when_the_month_is_used(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = signing_relay(monkeypatch, tmp_path, PODCAST_RELAY_LEGACY_MONTHLY_BYTES="50")
    with live_relay(monkeypatch, host_token=LEGACY_SECRET, app=app) as base:
        with _live_legacy_tunnel(base, "gtok") as tunnel:
            with ws_connect(f"{base}/api/review/gtok/daw/ws", open_timeout=5) as guest:
                stream_id = json.loads(tunnel.recv(timeout=5))["id"]
                tunnel.send(json.dumps({"type": "ws_data", "id": stream_id, "text": "h" * 30}))
                assert guest.recv(timeout=5) == "h" * 30
                guest.send("g" * 30)
                assert json.loads(tunnel.recv(timeout=5))["type"] in ("ws_data", "limit")
                with pytest.raises(ConnectionClosed) as closed:
                    guest.recv(timeout=5)
            assert closed.value.rcvd is not None and closed.value.rcvd.code == 1013

            with pytest.raises(ConnectionClosed) as refused:
                with ws_connect(f"{base}/api/review/gtok/daw/ws", open_timeout=5) as again:
                    again.recv(timeout=5)

    assert refused.value.rcvd is not None
    assert (refused.value.rcvd.code, refused.value.rcvd.reason) == (1013, "sharing paused")
