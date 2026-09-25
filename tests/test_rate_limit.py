"""Unit tests for token-bucket rate limiting and host/relay classifiers."""

from __future__ import annotations

import re

import pytest

from podcast_mcp.services.remote_mcp.limits import (
    check_host_bucket,
    classify_mcp_rpc,
    classify_review_request,
    reset_host_limiters_for_tests,
)
from podcast_mcp.util.rate_limit import (
    ConcurrencyGate,
    KeyedLimiter,
    RateLimitDecision,
    TokenBucket,
    env_flag,
    rate_limit_detail,
)
from podcast_relay.limits import (
    check_proxy_rpm,
    check_register,
    get_relay_limiters,
    is_audio_path,
    reset_relay_limiters_for_tests,
)


def test_token_bucket_burst_then_refill():
    now = [0.0]
    b = TokenBucket(rate_per_min=60.0, burst=2.0, clock=lambda: now[0])
    assert b.try_take()[0] is True
    assert b.try_take()[0] is True
    ok, retry = b.try_take()
    assert ok is False
    assert retry > 0
    now[0] = 1.0
    assert b.try_take()[0] is True


def test_keyed_limiter_isolates_keys():
    lim = KeyedLimiter(rate_per_min=60, burst=1, bucket_name="t")
    assert lim.allow("a").allowed
    assert not lim.allow("a").allowed
    assert lim.allow("b").allowed


def test_concurrency_gate():
    g = ConcurrencyGate(limit=1, bucket_name="c")
    assert g.try_enter("k").allowed
    assert not g.try_enter("k").allowed
    g.exit("k")
    assert g.try_enter("k").allowed
    g.exit("k")


def test_concurrency_gate_decrement_and_zero_rate_bucket():
    g = ConcurrencyGate(limit=2, bucket_name="c2")
    assert g.try_enter("k").allowed
    assert g.try_enter("k").allowed
    g.exit("k")  # cur > 1 → decrement branch
    g.exit("k")
    g.exit("missing")  # no-op pop
    g.reset()

    b = TokenBucket(rate_per_min=0.0, burst=1.0)
    assert b.try_take()[0] is True
    ok, retry = b.try_take()
    assert ok is False
    assert retry == 60.0

    detail = rate_limit_detail(
        RateLimitDecision(allowed=False, bucket="host_read", retry_after_sec=1.2)
    )
    assert detail["bucket"] == "host_read"
    assert detail["detail"] == "rate limit exceeded"


def test_env_flag(monkeypatch):
    monkeypatch.delenv("PODCAST_X", raising=False)
    assert env_flag("PODCAST_X", default=True) is True
    monkeypatch.setenv("PODCAST_X", "0")
    assert env_flag("PODCAST_X", default=True) is False


def test_classify_mcp_and_review():
    assert classify_mcp_rpc("initialize") == "read"
    assert classify_mcp_rpc("tools/call", "guest_get_project") == "read"
    assert classify_mcp_rpc("tools/call", "guest_add_comment") == "mutate"
    assert classify_mcp_rpc("tools/call", "guest_pending_preview") == "mutate"
    assert classify_mcp_rpc("tools/call", "guest_audition_context") == "mutate"
    assert classify_mcp_rpc("tools/call", "guest_upload_media") == "mutate"
    assert classify_review_request("GET", "/api/review/t/daw/meta") == "read"
    assert classify_review_request("POST", "/api/review/t/comments") == "mutate"
    assert classify_review_request("GET", "/api/review/t/audio") == "audio"
    assert classify_review_request("GET", "/api/review/t/daw/pending-preview") == "audio"
    assert classify_review_request("GET", "/api/review/t/daw/audition-context") == "audio"
    assert classify_review_request("GET", "/api/review/t/daw/audition-context-image") == "audio"
    assert classify_review_request("GET", "/api/review/t/daw/waveform/tiles/abc") == "audio"
    assert classify_review_request("GET", "/api/review/t/DAW/Waveform/Tiles/abc") == "audio"
    assert classify_review_request("GET", "/api/review/t/daw/waveform/status") == "read"


def test_host_and_relay_audio_classifiers_agree_on_guest_routes():
    from podcast_mcp.gui.routes import review_share

    checked = 0
    for route in review_share.router.routes:
        path = getattr(route, "path", "")
        methods = getattr(route, "methods", None) or set()
        if "GET" not in methods or not path.startswith("/api/review/{token}/"):
            continue
        concrete = re.sub(r"\{[^}]+\}", "x", path)
        host_audio = classify_review_request("GET", concrete) == "audio"
        assert is_audio_path(concrete.lstrip("/")) == host_audio, concrete
        upper = concrete.upper()
        assert (classify_review_request("GET", upper) == "audio") == host_audio, upper
        assert is_audio_path(upper.lstrip("/")) == host_audio, upper
        checked += 1
    assert checked >= 10


def test_is_audio_path():
    assert is_audio_path("api/review/tok/audio")
    assert is_audio_path("api/review/tok/daw/audio")
    assert is_audio_path("api/review/tok/daw/pending-preview")
    assert is_audio_path("api/review/tok/daw/pending-preview-image")
    assert is_audio_path("api/review/tok/daw/audition-context")
    assert is_audio_path("api/review/tok/daw/audition-context-image")
    assert is_audio_path("api/review/tok/daw/waveform/tiles/0123456789abcdef0123?ref=track:a")
    assert not is_audio_path("api/review/tok/daw/waveform/status")
    assert not is_audio_path("api/review/tok/daw/meta")
    assert not is_audio_path("mcp/tok/mcp")


def test_relay_rpm_with_tiny_budget(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_RATE_LIMIT", "1")
    monkeypatch.setenv("PODCAST_RELAY_TOKEN_RPM", "60")
    monkeypatch.setenv("PODCAST_RELAY_TOKEN_BURST", "1")
    monkeypatch.setenv("PODCAST_RELAY_IP_RPM", "10000")
    monkeypatch.setenv("PODCAST_RELAY_IP_BURST", "100")
    reset_relay_limiters_for_tests()
    assert check_proxy_rpm(
        token="t1", client_ip="1.1.1.1", path_suffix="api/review/t1/daw/meta"
    ).allowed
    denied = check_proxy_rpm(token="t1", client_ip="1.1.1.1", path_suffix="api/review/t1/daw/meta")
    assert not denied.allowed
    assert denied.bucket == "relay_token"
    # Audio skips RPM
    assert check_proxy_rpm(
        token="t1", client_ip="1.1.1.1", path_suffix="api/review/t1/audio"
    ).allowed
    reset_relay_limiters_for_tests()


def test_relay_ip_bucket_denies(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_RATE_LIMIT", "1")
    monkeypatch.setenv("PODCAST_RELAY_TOKEN_RPM", "100000")
    monkeypatch.setenv("PODCAST_RELAY_TOKEN_BURST", "100")
    monkeypatch.setenv("PODCAST_RELAY_IP_RPM", "60")
    monkeypatch.setenv("PODCAST_RELAY_IP_BURST", "1")
    reset_relay_limiters_for_tests()
    assert check_proxy_rpm(
        token="t-a", client_ip="9.9.9.9", path_suffix="api/review/t-a/daw/meta"
    ).allowed
    denied = check_proxy_rpm(
        token="t-b", client_ip="9.9.9.9", path_suffix="api/review/t-b/daw/meta"
    )
    assert not denied.allowed
    assert denied.bucket == "relay_ip"
    reset_relay_limiters_for_tests()


def test_register_rate_limit(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_RATE_LIMIT", "1")
    monkeypatch.setenv("PODCAST_RELAY_REGISTER_RPM", "60")
    monkeypatch.setenv("PODCAST_RELAY_REGISTER_BURST", "1")
    reset_relay_limiters_for_tests()
    assert check_register("host-tok").allowed
    assert not check_register("host-tok").allowed
    reset_relay_limiters_for_tests()


def test_host_mutate_budget(monkeypatch):
    monkeypatch.setenv("PODCAST_RATE_LIMIT", "1")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_MUTATE_RPM", "60")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_MUTATE_BURST", "1")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_READ_RPM", "10000")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_READ_BURST", "100")
    reset_host_limiters_for_tests()
    assert check_host_bucket("tok", "mutate").allowed
    assert not check_host_bucket("tok", "mutate").allowed
    assert check_host_bucket("tok", "read").allowed
    assert check_host_bucket("tok", "audio").allowed
    reset_host_limiters_for_tests()


def test_limits_disabled_via_env(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_RATE_LIMIT", "0")
    monkeypatch.setenv("PODCAST_RATE_LIMIT", "0")
    reset_relay_limiters_for_tests()
    reset_host_limiters_for_tests()
    assert check_register("x").allowed
    assert check_proxy_rpm(token="t", client_ip=None, path_suffix="api/review/t/daw/meta").allowed
    assert check_host_bucket("t", "mutate").allowed
    reset_relay_limiters_for_tests()
    reset_host_limiters_for_tests()


def test_keyed_limiter_evicts_when_full():
    lim = KeyedLimiter(rate_per_min=60, burst=1, bucket_name="e", max_keys=2)
    assert lim.allow("a").allowed
    assert lim.allow("b").allowed
    assert lim.allow("c").allowed  # evicts one
    lim.reset()


def test_relay_concurrency_denies(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_RATE_LIMIT", "1")
    monkeypatch.setenv("PODCAST_RELAY_TOKEN_CONCURRENT", "1")
    monkeypatch.setenv("PODCAST_RELAY_HOST_CONCURRENT", "1")
    monkeypatch.setenv("PODCAST_RELAY_AUDIO_CONCURRENT", "1")
    reset_relay_limiters_for_tests()
    lim = get_relay_limiters()
    assert lim.token_concurrent.try_enter("t").allowed
    assert not lim.token_concurrent.try_enter("t").allowed
    lim.token_concurrent.exit("t")
    assert lim.audio_concurrent.try_enter("t").allowed
    lim.audio_concurrent.exit("t")
    reset_relay_limiters_for_tests()


def test_env_float_invalid(monkeypatch):
    from podcast_mcp.util.rate_limit import env_float

    monkeypatch.setenv("PODCAST_BAD", "nope")
    assert env_float("PODCAST_BAD", 3.5) == 3.5


@pytest.mark.asyncio
async def test_relay_proxy_returns_429(monkeypatch):
    import base64

    from httpx import ASGITransport, AsyncClient

    from podcast_relay.app import TunnelSession, create_relay_app

    monkeypatch.setenv("PODCAST_RELAY_RATE_LIMIT", "1")
    monkeypatch.setenv("PODCAST_RELAY_TOKEN_RPM", "60")
    monkeypatch.setenv("PODCAST_RELAY_TOKEN_BURST", "1")
    monkeypatch.setenv("PODCAST_RELAY_IP_RPM", "100000")
    monkeypatch.setenv("PODCAST_RELAY_IP_BURST", "1000")
    monkeypatch.setenv("PODCAST_RELAY_TOKEN_CONCURRENT", "100")
    monkeypatch.setenv("PODCAST_RELAY_HOST_CONCURRENT", "100")
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    reset_relay_limiters_for_tests()

    class _Ws:
        def __init__(self) -> None:
            self._session = None

        async def send_json(self, data: dict) -> None:
            if data.get("type") != "http" or self._session is None:
                return
            from podcast_relay.app import _ingest_http_response

            pending = self._session.pending.get(data["id"])
            if pending is None:
                return
            await _ingest_http_response(
                pending,
                {
                    "status": 200,
                    "headers": {"content-type": "text/plain"},
                    "body_b64": base64.b64encode(b"ok").decode("ascii"),
                    "eof": True,
                },
            )

    app = create_relay_app()
    state = app.state.relay
    ws = _Ws()
    session = TunnelSession(host_id="h1", websocket=ws, host_token="secret")  # type: ignore[arg-type]
    ws._session = session

    await state.register_tunnel(session)
    from podcast_relay.share_claims import attach_share_claims

    await state.update_shares(
        "h1",
        attach_share_claims(
            [{"token": "rtok", "capabilities": ["play", "view", "mcp"]}],
            host_id="h1",
            secret="secret",
        ),
    )

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://t") as http:
        r1 = await http.get("/api/review/rtok/daw/meta")
        assert r1.status_code == 200
        r2 = await http.get("/api/review/rtok/daw/meta")
        assert r2.status_code == 429
        assert r2.json()["bucket"] == "relay_token"
        assert "Retry-After" in r2.headers
    reset_relay_limiters_for_tests()


def test_host_mcp_mutate_429(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from pathlib import Path

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.models import load_project, save_project
    from podcast_mcp.services import ProjectWorkspace, ReviewService
    from podcast_mcp.services.share import ShareService

    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    monkeypatch.setenv("PODCAST_RATE_LIMIT", "1")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_MUTATE_RPM", "60")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_MUTATE_BURST", "1")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_READ_RPM", "10000")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_READ_BURST", "100")

    now = [0.0]
    reset_host_limiters_for_tests(clock=lambda: now[0])

    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="rl")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view", "comment", "mcp"],
    )
    client = TestClient(create_app())
    path = f"/mcp/{share['token']}/mcp"
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "guest_add_comment",
            "arguments": {
                "body": "a",
                "author": "t",
                "timeline_start": 0.0,
            },
        },
    }
    r1 = client.post(path, json=body)
    assert r1.status_code == 200
    body["id"] = 2
    r2 = client.post(path, json=body)
    assert r2.status_code == 429
    err = r2.json()["error"]
    assert err["code"] == -32029
    assert "rate limit" in err["message"].lower()
    reset_host_limiters_for_tests()


def test_host_review_and_mcp_info_read_429(minimal_project, sample_wav, tmp_workspace, monkeypatch):
    from pathlib import Path

    from fastapi.testclient import TestClient

    from podcast_mcp.gui.server import create_app
    from podcast_mcp.models import load_project, save_project
    from podcast_mcp.services import ProjectWorkspace, ReviewService
    from podcast_mcp.services.share import ShareService

    monkeypatch.setenv("PODCAST_REMOTE_MCP", "1")
    monkeypatch.setenv("PODCAST_RATE_LIMIT", "1")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_READ_RPM", "60")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_READ_BURST", "1")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_MUTATE_RPM", "10000")
    monkeypatch.setenv("PODCAST_RATE_LIMIT_MUTATE_BURST", "100")

    reset_host_limiters_for_tests(clock=lambda: 0.0)

    proj = load_project(minimal_project)
    art = Path(proj.workspace_dir) / "artifacts"
    art.mkdir(parents=True, exist_ok=True)
    (art / "premix.wav").write_bytes(sample_wav.read_bytes())
    save_project(proj, minimal_project)
    ws = ProjectWorkspace.open(minimal_project)
    ver = ReviewService(ws).publish(label="rl-read")
    share = ShareService(ws).create(
        review_version_id=ver["id"],
        capabilities=["play", "view", "mcp"],
    )
    token = share["token"]
    client = TestClient(create_app())

    r1 = client.get(f"/api/review/{token}/daw/meta")
    assert r1.status_code == 200
    r2 = client.get(f"/api/review/{token}/daw/meta")
    assert r2.status_code == 429
    assert r2.headers.get("Retry-After")
    assert r2.json()["detail"]["bucket"] == "host_read"

    reset_host_limiters_for_tests(clock=lambda: 0.0)
    info1 = client.get(f"/mcp/{token}")
    assert info1.status_code == 200
    info2 = client.get(f"/mcp/{token}")
    assert info2.status_code == 429
    reset_host_limiters_for_tests()
