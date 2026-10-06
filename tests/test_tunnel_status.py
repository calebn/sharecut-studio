"""Tunnel lifecycle: status lines, GUI snapshot transitions, failure handling, redaction.

A scripted fake relay replaces ``websockets.connect`` so each test drives a drop and
reconnect without a network, then asserts the exact lines the host would read.
"""

from __future__ import annotations

import asyncio
import errno
import json
import re
import socket
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from typer.testing import CliRunner
from websockets.exceptions import ConnectionClosedError, InvalidStatus, InvalidURI
from websockets.frames import Close
from websockets.http11 import Response

from podcast_mcp.cli.main import app
from podcast_mcp.runtime_config import RelayConfig
from podcast_mcp.services.collaboration.tunnel import TunnelClient
from podcast_mcp.services.collaboration.tunnel_failure import (
    FailureKind,
    TunnelError,
    TunnelFailure,
    classify_failure,
)
from podcast_mcp.services.collaboration.tunnel_status import (
    STALE_AFTER_SEC,
    LineListener,
    StatusFileListener,
    TunnelPhase,
    TunnelState,
    TunnelStatusTracker,
    read_tunnel_status,
    tunnel_status_dir,
    tunnel_status_path,
)

HOST_TOKEN = "host-secret-9f3a1c7e5b"
SHARE_TOKEN = "fantastic-acoustic-whale"
RELAY_URL = "wss://relay.example.test:8443/tunnel"
PUBLIC = "https://share.example.test"

ACK = [
    {"type": "hello", "ok": True, "host_id": "hid"},
    {"type": "register", "ok": True, "share_count": 2},
]


class FakeRelay:
    """One scripted relay connection: replay ``frames``, then raise ``then``."""

    def __init__(self, frames: list[dict], then: BaseException | None = None) -> None:
        self._frames = list(frames)
        self._then = then or asyncio.CancelledError()
        self.sent: list[dict] = []

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))

    async def recv(self) -> str:
        if self._frames:
            return json.dumps(self._frames.pop(0))
        raise self._then

    async def __aenter__(self) -> FakeRelay:
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None


def _scripted_connect(*steps: FakeRelay | BaseException):
    """A ``websockets.connect`` stand-in: each call yields the next relay or raises."""
    queue = list(steps)

    def connect(*_a: Any, **_k: Any) -> FakeRelay:
        step = queue.pop(0)
        if isinstance(step, BaseException):
            raise step
        return step

    return connect


class Recorder:
    """A status listener that keeps every transition as the GUI would see it."""

    def __init__(self, status_file: Path | None = None) -> None:
        self.transitions: list[tuple[TunnelPhase, TunnelState]] = []
        self.records: list[dict] = []
        self._status_file = status_file

    def on_transition(self, status: Any) -> None:
        self.transitions.append((status.phase, status.state))
        if self._status_file is not None and self._status_file.exists():
            self.records.append(json.loads(self._status_file.read_text()))

    def on_heartbeat(self, status: Any) -> None:
        return None


class Harness:
    """A tunnel client wired to recorders for lines, transitions and backoff waits."""

    def __init__(self, tmp_path: Path) -> None:
        self.lines: list[str] = []
        self.waits: list[float] = []
        self.status_file = tmp_path / "tunnel_status.json"
        self.recorder = Recorder(self.status_file)

        async def sleep(seconds: float) -> None:
            self.waits.append(seconds)

        cfg = RelayConfig(
            relay_url=RELAY_URL,
            host_token=HOST_TOKEN,
            public_base_url=PUBLIC,
            host_id="hid",
        )
        self.client = TunnelClient(
            cfg,
            listeners=[
                LineListener(self.lines.append),
                StatusFileListener(self.status_file),
                self.recorder,
            ],
            sleep=sleep,
        )

    async def run(self, *steps: FakeRelay | BaseException, **kwargs: Any) -> None:
        rng = MagicMock()
        rng.uniform.return_value = 0.0
        with (
            patch("websockets.connect", side_effect=_scripted_connect(*steps)),
            patch("httpx.AsyncClient") as http_cls,
            patch("secrets.SystemRandom", return_value=rng),
        ):
            http = AsyncMock()
            http.__aenter__ = AsyncMock(return_value=http)
            http.__aexit__ = AsyncMock(return_value=None)
            http_cls.return_value = http
            await self.client.run(**kwargs)


@pytest.mark.asyncio
async def test_relay_drop_and_reconnect_prints_each_state_change(tmp_path: Path):
    h = Harness(tmp_path)

    with pytest.raises(asyncio.CancelledError):
        await h.run(
            FakeRelay(ACK, then=ConnectionClosedError(None, None)),
            OSError(errno.ECONNREFUSED, "Connection refused"),
            FakeRelay(ACK),
            initial_delay_sec=1.0,
        )

    assert h.lines == [
        "Tunnel connecting to relay.example.test:8443",
        f"Tunnel connected: {PUBLIC} (2 shares)",
        "Tunnel disconnected (network: connection lost)",
        "Tunnel reconnecting in 1.0s (attempt 1)",
        "Tunnel disconnected (network: relay refused the connection)",
        "Tunnel reconnecting in 2.0s (attempt 2)",
        f"Tunnel connected: {PUBLIC} (2 shares)",
        "Tunnel stopped",
    ]
    assert h.waits == [1.0, 2.0]
    assert h.recorder.transitions == [
        (TunnelPhase.CONNECTING, TunnelState.CONNECTING),
        (TunnelPhase.CONNECTED, TunnelState.ONLINE),
        (TunnelPhase.DISCONNECTED, TunnelState.RECONNECTING),
        (TunnelPhase.RECONNECTING, TunnelState.RECONNECTING),
        (TunnelPhase.DISCONNECTED, TunnelState.RECONNECTING),
        (TunnelPhase.RECONNECTING, TunnelState.RECONNECTING),
        (TunnelPhase.CONNECTED, TunnelState.ONLINE),
        (TunnelPhase.STOPPED, TunnelState.OFF),
    ]


@pytest.mark.asyncio
async def test_backoff_doubles_while_down_and_resets_after_a_connected_session(tmp_path: Path):
    h = Harness(tmp_path)
    refused = OSError(errno.ECONNREFUSED, "Connection refused")

    with pytest.raises(asyncio.CancelledError):
        await h.run(
            refused,
            refused,
            FakeRelay(ACK, then=ConnectionClosedError(None, None)),
            FakeRelay(ACK),
            initial_delay_sec=1.0,
        )

    assert h.waits == [1.0, 2.0, 1.0]
    assert [line for line in h.lines if "reconnecting" in line] == [
        "Tunnel reconnecting in 1.0s (attempt 1)",
        "Tunnel reconnecting in 2.0s (attempt 2)",
        "Tunnel reconnecting in 1.0s (attempt 1)",
    ]


@pytest.mark.asyncio
async def test_status_file_follows_the_phase_the_gui_reads(tmp_path: Path):
    h = Harness(tmp_path)

    with pytest.raises(asyncio.CancelledError):
        await h.run(FakeRelay(ACK, then=ConnectionClosedError(None, None)), FakeRelay(ACK))

    records = h.recorder.records
    assert [(r["phase"], r["state"]) for r in records] == [
        ("connecting", "connecting"),
        ("connected", "online"),
        ("disconnected", "reconnecting"),
        ("reconnecting", "reconnecting"),
        ("connected", "online"),
        ("stopped", "off"),
    ]
    online, dropped, waiting = records[1], records[2], records[3]
    assert online["relay_host"] == "relay.example.test:8443"
    assert online["public_base_url"] == PUBLIC
    assert online["share_count"] == 2
    assert dropped["reason"] == "network: connection lost"
    assert waiting["retry_at"] == waiting["since"] + 1.0
    assert "attempt" not in waiting
    assert HOST_TOKEN not in h.status_file.read_text()


@pytest.mark.asyncio
async def test_rejected_host_token_fails_without_retrying(tmp_path: Path):
    h = Harness(tmp_path)
    rejected = FakeRelay([{"type": "error", "detail": "invalid host_token for host_id"}])

    with pytest.raises(TunnelError) as caught:
        await h.run(rejected)

    assert caught.value.failure.kind is FailureKind.AUTH
    assert h.lines == [
        "Tunnel connecting to relay.example.test:8443",
        "Tunnel failed (auth: relay rejected the host token or host id). "
        "Check the host token (--host-token, PODCAST_RELAY_HOST_TOKEN or relay.yaml) "
        "and the host id, then run podcast tunnel again.",
    ]
    assert h.waits == []
    assert h.client.tracker.status.state is TunnelState.OFFLINE
    assert HOST_TOKEN not in "\n".join(h.lines)


@pytest.mark.asyncio
async def test_wrong_relay_path_is_a_config_failure(tmp_path: Path):
    h = Harness(tmp_path)
    not_found = InvalidStatus(Response(404, "Not Found", MagicMock(), b""))

    with pytest.raises(TunnelError) as caught:
        await h.run(not_found)

    assert caught.value.failure.kind is FailureKind.CONFIG
    assert h.lines[-1].startswith(
        "Tunnel failed (config: relay has no tunnel endpoint at relay_url)"
    )
    assert h.waits == []


@pytest.mark.asyncio
async def test_relay_rate_limit_backs_off_at_least_as_long_as_it_asks(tmp_path: Path):
    h = Harness(tmp_path)
    limited = FakeRelay([{"type": "error", "detail": "rate limit exceeded", "retry_after_sec": 30}])

    with pytest.raises(asyncio.CancelledError):
        await h.run(limited, FakeRelay(ACK), initial_delay_sec=1.0)

    assert h.lines[1:3] == [
        "Tunnel disconnected (rate limited: relay is rate limiting tunnel registration)",
        "Tunnel reconnecting in 30.0s (attempt 1)",
    ]
    assert h.waits == [30.0]


@pytest.mark.asyncio
async def test_gives_up_after_max_attempts(tmp_path: Path):
    h = Harness(tmp_path)
    down = OSError(errno.ENETUNREACH, "Network is unreachable")

    with pytest.raises(OSError, match="unreachable"):
        await h.run(down, down, max_attempts=2, initial_delay_sec=1.0)

    assert h.lines[-1] == "Tunnel gave up after 2 attempts (network: network unreachable)"
    assert h.client.tracker.status.state is TunnelState.OFFLINE


@pytest.mark.asyncio
async def test_relay_ping_is_a_debug_log_not_a_status_line(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
):
    h = Harness(tmp_path)
    caplog.set_level("DEBUG", logger="podcast_mcp.services.collaboration.tunnel")

    with pytest.raises(asyncio.CancelledError):
        await h.run(FakeRelay([*ACK, {"type": "ping"}]))

    assert "Relay ping answered" in caplog.text
    assert h.lines == [
        "Tunnel connecting to relay.example.test:8443",
        f"Tunnel connected: {PUBLIC} (2 shares)",
        "Tunnel stopped",
    ]


def test_heartbeat_refreshes_the_snapshot_without_a_line(tmp_path: Path):
    lines: list[str] = []
    now = [100.0]
    status_file = tmp_path / "tunnel_status.json"
    tracker = TunnelStatusTracker(
        relay_host="relay.example.test",
        public_base_url=PUBLIC,
        listeners=[LineListener(lines.append), StatusFileListener(status_file)],
        clock=lambda: now[0],
    )
    tracker.connected(share_count=1)
    now[0] = 115.0
    tracker.heartbeat()

    record = json.loads(status_file.read_text())
    assert (record["since"], record["updated_at"]) == (100.0, 115.0)
    assert lines == [f"Tunnel connected: {PUBLIC} (1 share)"]


# --- redaction -------------------------------------------------------------


@pytest.mark.asyncio
async def test_host_and_share_tokens_never_reach_a_line_or_the_snapshot(tmp_path: Path):
    h = Harness(tmp_path)
    boom = RuntimeError(
        f"upstream said {HOST_TOKEN} at /r/{SHARE_TOKEN}/api and token={HOST_TOKEN}"
    )

    with pytest.raises(asyncio.CancelledError):
        await h.run(boom, FakeRelay(ACK))

    everything = "\n".join(h.lines) + h.status_file.read_text()
    assert HOST_TOKEN not in everything
    assert SHARE_TOKEN not in everything
    assert (
        "Tunnel disconnected (error: RuntimeError: upstream said <redacted> "
        "at /r/<share-token>/api and token=<redacted>)"
    ) in h.lines


def test_known_share_tokens_are_masked_even_without_a_path(tmp_path: Path):
    h = Harness(tmp_path)
    rows = [{"token": SHARE_TOKEN, "capabilities": ["play"]}]
    h.client._project_path = Path("episode.project.json")
    with (
        patch("podcast_mcp.services.collaboration.tunnel.load_project", return_value=object()),
        patch("podcast_mcp.services.collaboration.tunnel.list_usable_shares", return_value=rows),
    ):
        advertised = h.client._build_shares()

    assert [row["token"] for row in advertised] == [SHARE_TOKEN]
    assert h.client.tracker.redact(f"guest {SHARE_TOKEN} left, host {HOST_TOKEN}") == (
        "guest <redacted> left, host <redacted>"
    )


@pytest.mark.asyncio
async def test_proxy_error_log_hides_share_token_and_host_token(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
):
    h = Harness(tmp_path)
    http = MagicMock()
    http.stream.side_effect = RuntimeError(f"connect failed for {HOST_TOKEN}")
    send = AsyncMock()

    with caplog.at_level("WARNING"):
        await h.client._proxy_http(
            http,
            {"id": "1", "method": "GET", "path": "r/comments", "share_token": SHARE_TOKEN},
            send=send,
        )

    assert "Proxy error" in caplog.text
    assert SHARE_TOKEN not in caplog.text
    assert HOST_TOKEN not in caplog.text
    assert send.await_args.args[0]["status"] == 502


# --- classification --------------------------------------------------------


@pytest.mark.parametrize(
    ("exc", "kind", "detail"),
    [
        (
            ConnectionClosedError(Close(1011, "keepalive ping timeout"), None),
            FailureKind.TIMEOUT,
            "relay stopped answering keepalive pings",
        ),
        (
            ConnectionClosedError(None, Close(1011, "keepalive ping timeout")),
            FailureKind.TIMEOUT,
            "relay stopped answering keepalive pings",
        ),
        (
            ConnectionClosedError(Close(1012, "service restart"), None),
            FailureKind.RELAY_CLOSED,
            "close code 1012, service restart",
        ),
        (
            ConnectionClosedError(Close(1013, "host tunnel replaced"), None),
            FailureKind.RELAY_CLOSED,
            "close code 1013, host tunnel replaced",
        ),
        (
            ConnectionClosedError(Close(4403, ""), None),
            FailureKind.AUTH,
            "relay rejected the host token or host id",
        ),
        (
            ConnectionClosedError(Close(4429, ""), None),
            FailureKind.RATE_LIMITED,
            "relay is rate limiting this host",
        ),
        (ConnectionClosedError(None, None), FailureKind.NETWORK, "connection lost"),
        (TimeoutError(), FailureKind.TIMEOUT, "relay did not answer in time"),
        (
            socket.gaierror(8, "nodename nor servname"),
            FailureKind.NETWORK,
            "cannot resolve the relay host",
        ),
        (OSError(errno.ENETUNREACH, "x"), FailureKind.NETWORK, "network unreachable"),
        (OSError(errno.ECONNRESET, "x"), FailureKind.NETWORK, "connection reset"),
        (InvalidURI("nope", "bad"), FailureKind.CONFIG, "relay_url is not a valid websocket URL"),
        (
            InvalidStatus(Response(403, "Forbidden", MagicMock(), b"")),
            FailureKind.AUTH,
            "relay refused the connection (HTTP 403)",
        ),
        (
            InvalidStatus(Response(502, "Bad Gateway", MagicMock(), b"")),
            FailureKind.RELAY_CLOSED,
            "relay unavailable (HTTP 502)",
        ),
        (ValueError("odd"), FailureKind.ERROR, "ValueError: odd"),
    ],
)
def test_classify_failure(exc: BaseException, kind: FailureKind, detail: str):
    failure = classify_failure(exc)
    assert (failure.kind, failure.detail) == (kind, detail)
    assert failure.fatal is (kind in {FailureKind.AUTH, FailureKind.CONFIG})


def test_fatal_failures_carry_a_fix_and_retryable_ones_do_not():
    assert "relay_url" in TunnelFailure(FailureKind.CONFIG, "x").hint
    assert TunnelFailure(FailureKind.NETWORK, "x").hint == ""


# --- GUI snapshot ----------------------------------------------------------


def _write(path: Path, **overrides: Any) -> Path:
    record: dict[str, Any] = {
        "schema": 1,
        "phase": "connected",
        "state": "online",
        "relay_host": "relay.example.test",
        "public_base_url": PUBLIC,
        "share_count": 2,
        "reason": None,
        "reason_kind": None,
        "retry_at": None,
        "since": 1000.0,
        "updated_at": 1000.0,
    }
    record.update(overrides)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record), encoding="utf-8")
    return path


def _status(**kwargs: Any) -> dict[str, Any]:
    return read_tunnel_status(relay_configured=True, **kwargs)


def test_read_status_passes_a_fresh_snapshot_through(tmp_path: Path):
    _write(tmp_path / "a.json")
    assert _status(directory=tmp_path, now=1010.0)["state"] == "online"


def test_live_snapshot_turns_offline_once_the_heartbeat_is_older_than_the_ttl(tmp_path: Path):
    _write(tmp_path / "a.json")

    at_ttl = _status(directory=tmp_path, now=1000.0 + STALE_AFTER_SEC)
    past_ttl = _status(directory=tmp_path, now=1000.0 + STALE_AFTER_SEC + 1)

    assert STALE_AFTER_SEC == 45.0
    assert at_ttl["state"] == "online"
    assert (past_ttl["state"], past_ttl["reason"]) == (
        "offline",
        "podcast tunnel stopped responding",
    )
    assert (past_ttl["relay_host"], past_ttl["since"]) == ("relay.example.test", 1000.0)


def test_read_status_keeps_a_failed_snapshot_until_it_is_abandoned(tmp_path: Path):
    _write(
        tmp_path / "a.json",
        phase="failed",
        state="offline",
        reason="auth: relay rejected the host token or host id",
        reason_kind="auth",
    )
    report = _status(directory=tmp_path, now=1600.0)
    assert (report["state"], report["reason_kind"]) == ("offline", "auth")


def test_a_local_only_host_reads_not_set_up_and_a_configured_one_reads_off(tmp_path: Path):
    assert read_tunnel_status(relay_configured=False, directory=tmp_path)["state"] == ("not_set_up")
    assert read_tunnel_status(relay_configured=True, directory=tmp_path)["state"] == "off"
    _write(tmp_path / "a.json", phase="stopped", state="off")
    assert read_tunnel_status(relay_configured=False, directory=tmp_path)["state"] == "off"


def test_unreadable_snapshots_are_skipped(tmp_path: Path):
    (tmp_path / "bad.json").write_text("{not json", encoding="utf-8")
    (tmp_path / "old.json").write_text(json.dumps({"schema": 0}), encoding="utf-8")
    assert _status(directory=tmp_path)["state"] == "off"
    _write(tmp_path / "good.json", since=1000.0, updated_at=1000.0)
    assert _status(directory=tmp_path, now=1001.0)["state"] == "online"


def test_two_tunnels_write_separate_files_and_the_gui_shows_the_best(tmp_path: Path):
    first = RelayConfig(relay_url=RELAY_URL, host_id="host-a")
    second = RelayConfig(relay_url="wss://other.example.test/tunnel", host_id="host-a")
    third = RelayConfig(relay_url=RELAY_URL, host_id="host-b")
    paths = {tunnel_status_path(cfg) for cfg in (first, second, third)}
    assert len(paths) == 3
    assert {path.parent for path in paths} == {tunnel_status_dir()}
    assert tunnel_status_path(first) == tunnel_status_path(
        RelayConfig(relay_url=RELAY_URL, host_id="host-a", host_token="other")
    )

    now = [2000.0]
    trackers = []
    for cfg in (first, second):
        trackers.append(
            TunnelStatusTracker(
                relay_host=cfg.relay_url,
                public_base_url=PUBLIC,
                listeners=[StatusFileListener(tunnel_status_path(cfg))],
                clock=lambda: now[0],
            )
        )
    trackers[0].connected(share_count=1)
    now[0] = 2010.0
    trackers[1].disconnected(TunnelFailure(FailureKind.NETWORK, "connection lost"))

    shown = read_tunnel_status(relay_configured=True, now=2011.0)
    assert (shown["state"], shown["relay_host"]) == ("online", RELAY_URL)
    trackers[0].stopped()
    shown = read_tunnel_status(relay_configured=True, now=2012.0)
    assert (shown["state"], shown["relay_host"]) == (
        "reconnecting",
        "wss://other.example.test/tunnel",
    )


def test_tunnel_status_route_is_host_only_and_serves_the_snapshot(tmp_path: Path):
    pytest.importorskip("fastapi")
    import time

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    client = TestClient(create_app())
    assert client.get("/api/tunnel/status").json()["state"] == "not_set_up"

    _write(tunnel_status_dir() / "a.json", since=time.time(), updated_at=time.time())
    ok = client.get("/api/tunnel/status")
    assert ok.status_code == 200
    assert ok.json()["state"] == "online"
    assert "tunnel.status" in client.get("/api/features").json()["features"]
    relayed = client.get("/api/tunnel/status", headers={"x-sharecut-relayed": "1"})
    assert relayed.status_code == 403


def test_relay_settings_in_the_environment_count_as_set_up(monkeypatch: pytest.MonkeyPatch):
    from podcast_mcp.runtime_config import default_relay_config_path, relay_configured

    assert relay_configured() is False
    monkeypatch.setenv("PODCAST_RELAY_URL", RELAY_URL)
    assert relay_configured() is True
    monkeypatch.delenv("PODCAST_RELAY_URL")
    default_relay_config_path().write_text(f"relay_url: {RELAY_URL}\n", encoding="utf-8")
    assert relay_configured() is True


# --- CLI -------------------------------------------------------------------


def test_cli_prints_timestamped_lines_and_exits_1_on_auth_failure(tmp_path: Path):
    config = tmp_path / "relay.yaml"
    config.write_text(f"relay_url: {RELAY_URL}\nhost_id: hid\n", encoding="utf-8")
    rejected = FakeRelay([{"type": "error", "detail": "invalid host_token for host_id"}])

    with patch("websockets.connect", return_value=rejected):
        result = CliRunner().invoke(
            app,
            ["--no-progress", "tunnel", "--config", str(config), "--host-token", HOST_TOKEN],
        )

    assert result.exit_code == 1
    stamped = [line for line in result.output.splitlines() if "Tunnel" in line]
    assert [re.sub(r"^\d\d:\d\d:\d\d ", "", line) for line in stamped[:1]] == [
        "Tunnel connecting to relay.example.test:8443"
    ]
    assert re.sub(r"^\d\d:\d\d:\d\d ", "", stamped[-1]).startswith("Tunnel failed (auth:")
    assert HOST_TOKEN not in result.output
    assert not (tmp_path / "tunnel_status.json").exists()
    record = read_tunnel_status(relay_configured=False)
    assert (record["phase"], record["state"], record["reason_kind"]) == (
        "failed",
        "offline",
        "auth",
    )


def test_gui_finds_the_status_of_a_tunnel_started_with_a_custom_config(tmp_path: Path):
    pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app

    elsewhere = tmp_path / "elsewhere" / "relay.yaml"
    elsewhere.parent.mkdir()
    elsewhere.write_text(f"relay_url: {RELAY_URL}\nhost_id: hid\n", encoding="utf-8")
    rejected = FakeRelay([{"type": "error", "detail": "invalid host_token for host_id"}])

    with patch("websockets.connect", return_value=rejected):
        result = CliRunner().invoke(
            app,
            ["--no-progress", "tunnel", "--config", str(elsewhere), "--host-token", HOST_TOKEN],
        )

    assert result.exit_code == 1
    shown = TestClient(create_app()).get("/api/tunnel/status").json()
    assert (shown["state"], shown["reason_kind"]) == ("offline", "auth")
    assert HOST_TOKEN not in json.dumps(shown)
