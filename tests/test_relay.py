"""Unit tests for podcast-relay state machine and HTTP routes."""

from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from podcast_mcp.relay.app import RelayState, TunnelSession, create_relay_app
from podcast_mcp.relay.protocol import msg

# ---------------------------------------------------------------------------
# RelayState unit tests (no real WebSocket needed)
# ---------------------------------------------------------------------------


def test_relay_state_token_ok_empty_rejects_by_default():
    state = RelayState(set())
    assert state.token_ok("anything") is False
    assert state.token_ok("") is False


def test_relay_state_token_ok_empty_open_tunnel():
    state = RelayState(set(), allow_open_tunnel=True)
    assert state.token_ok("anything") is True
    assert state.token_ok("") is False


def test_relay_state_token_ok_with_set():
    state = RelayState({"secret"})
    assert state.token_ok("secret") is True
    assert state.token_ok("wrong") is False
    assert state.token_ok("") is False


def test_relay_state_tunnel_for_token_missing():
    state = RelayState(set())
    assert state.tunnel_for_token("nope") is None


def test_relay_state_register_and_lookup():
    state = RelayState(set(), allow_open_tunnel=True)
    session = TunnelSession(host_id="h1", websocket=None)  # type: ignore[arg-type]
    asyncio.run(state.register_tunnel(session))
    assert state.tunnels["h1"] is session


def test_relay_state_update_shares_and_lookup():
    state = RelayState(set(), allow_open_tunnel=True)
    session = TunnelSession(host_id="h1", websocket=None)  # type: ignore[arg-type]
    asyncio.run(state.register_tunnel(session))
    asyncio.run(
        state.update_shares(
            "h1",
            [{"token": "tok1", "capabilities": ["play", "comment"]}],
        )
    )
    found = state.tunnel_for_token("tok1")
    assert found is session
    assert session.capabilities["tok1"] == ["play", "comment"]


def test_relay_state_update_shares_replaces_old():
    state = RelayState(set(), allow_open_tunnel=True)
    session = TunnelSession(host_id="h1", websocket=None)  # type: ignore[arg-type]
    asyncio.run(state.register_tunnel(session))
    asyncio.run(state.update_shares("h1", [{"token": "old"}]))
    asyncio.run(state.update_shares("h1", [{"token": "new"}]))
    assert state.tunnel_for_token("old") is None
    assert state.tunnel_for_token("new") is session
    assert "old" not in state.token_bindings


def test_relay_refuses_cross_host_token_remap():
    state = RelayState(set(), allow_open_tunnel=True)
    s1 = TunnelSession(host_id="h1", websocket=None)  # type: ignore[arg-type]
    s2 = TunnelSession(host_id="h2", websocket=None)  # type: ignore[arg-type]
    asyncio.run(state.register_tunnel(s1))
    asyncio.run(state.register_tunnel(s2))
    asyncio.run(state.update_shares("h1", [{"token": "shared"}]))
    asyncio.run(state.update_shares("h2", [{"token": "shared"}]))
    assert state.tunnel_for_token("shared") is s1
    assert "shared" not in s2.share_tokens


def test_relay_refuses_steal_after_disconnect():
    """Bindings survive unregister; another host cannot advertise the same token."""
    from podcast_relay.share_claims import attach_share_claims

    secret_a = "secret-a"
    secret_b = "secret-b"
    state = RelayState({secret_a, secret_b})
    s1 = TunnelSession(host_id="h1", websocket=None, host_token=secret_a)  # type: ignore[arg-type]
    s2 = TunnelSession(host_id="h2", websocket=None, host_token=secret_b)  # type: ignore[arg-type]
    asyncio.run(state.register_tunnel(s1))
    rows = attach_share_claims(
        [{"token": "cool-name", "capabilities": ["play"]}],
        host_id="h1",
        secret=secret_a,
    )
    asyncio.run(state.update_shares("h1", rows))
    asyncio.run(state.unregister_tunnel("h1"))
    asyncio.run(state.register_tunnel(s2))
    steal = attach_share_claims(
        [{"token": "cool-name", "capabilities": ["play"]}],
        host_id="h2",
        secret=secret_b,
    )
    asyncio.run(state.update_shares("h2", steal))
    assert "cool-name" not in s2.share_tokens
    assert state.token_bindings.get("cool-name") == "h1"

    # Original host reconnects and reclaims.
    s1b = TunnelSession(host_id="h1", websocket=None, host_token=secret_a)  # type: ignore[arg-type]
    asyncio.run(state.register_tunnel(s1b))
    asyncio.run(state.update_shares("h1", rows))
    assert state.tunnel_for_token("cool-name") is s1b


def test_relay_drops_bad_hmac_claim():
    from podcast_relay.share_claims import attach_share_claims, sign_share_claim

    secret = "good-secret"
    state = RelayState({secret})
    session = TunnelSession(host_id="h1", websocket=None, host_token=secret)  # type: ignore[arg-type]
    asyncio.run(state.register_tunnel(session))
    rows = attach_share_claims(
        [{"token": "tok", "capabilities": ["view"]}],
        host_id="h1",
        secret=secret,
    )
    rows[0]["claim"] = sign_share_claim(
        "wrong-secret",
        host_id="h1",
        token="tok",
        capabilities=["view"],
    )
    asyncio.run(state.update_shares("h1", rows))
    assert "tok" not in session.share_tokens


def test_relay_malformed_claim_length_does_not_abort_register():
    """Unequal claim length must drop that row, not raise and wipe siblings."""
    from podcast_relay.share_claims import attach_share_claims, verify_share_claim

    secret = "good-secret"
    assert (
        verify_share_claim(
            secret,
            host_id="h1",
            token="a",
            capabilities=["view"],
            claim="short",
        )
        is False
    )

    state = RelayState({secret})
    session = TunnelSession(host_id="h1", websocket=None, host_token=secret)  # type: ignore[arg-type]
    asyncio.run(state.register_tunnel(session))
    good = attach_share_claims(
        [{"token": "keep-me", "capabilities": ["view"]}],
        host_id="h1",
        secret=secret,
    )
    bad = [{"token": "drop-me", "capabilities": ["view"], "host_id": "h1", "claim": "nope"}]
    asyncio.run(state.update_shares("h1", good + bad))
    assert "keep-me" in session.share_tokens
    assert "drop-me" not in session.share_tokens


def test_response_headers_allowlist_drops_set_cookie():
    from podcast_relay.app import _response_headers

    out = _response_headers(
        {
            "Content-Type": "audio/wav",
            "Set-Cookie": "session=evil",
            "X-Powered-By": "secret",
            "Cache-Control": "no-cache",
        }
    )
    assert "Set-Cookie" not in out
    assert "X-Powered-By" not in out
    assert out["Content-Type"] == "audio/wav"
    assert out["Cache-Control"] == "no-cache"


def test_relay_state_unregister_removes_live_routing_keeps_binding():
    state = RelayState(set(), allow_open_tunnel=True)
    session = TunnelSession(host_id="h1", websocket=None)  # type: ignore[arg-type]
    asyncio.run(state.register_tunnel(session))
    asyncio.run(state.update_shares("h1", [{"token": "tok1"}]))
    asyncio.run(state.unregister_tunnel("h1"))
    assert state.tunnel_for_token("tok1") is None
    assert "h1" not in state.tunnels
    assert state.token_bindings.get("tok1") == "h1"


def test_relay_state_unregister_noop_unknown():
    state = RelayState(set())
    asyncio.run(state.unregister_tunnel("ghost"))  # should not raise


# ---------------------------------------------------------------------------
# HTTP route tests via TestClient (no real tunnel)
# ---------------------------------------------------------------------------


def test_healthz_no_tunnels():
    client = TestClient(create_relay_app())
    resp = client.get("/healthz")
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["tunnels"] == 0
    assert data["shares"] == 0


def test_llms_txt_present():
    client = TestClient(create_relay_app())
    resp = client.get("/llms.txt")
    assert resp.status_code == 200
    assert "Podcast MCP" in resp.text
    assert "/r/{token}" in resp.text
    assert "/rec/{token}" in resp.text
    assert "docs.sharecut.studio" in resp.text


def test_relay_swagger_disabled():
    client = TestClient(create_relay_app())
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404
    assert client.get("/redoc").status_code == 404


def test_read_relay_version_env_override(monkeypatch):
    from podcast_mcp.relay.version import read_relay_git_sha, read_relay_version

    monkeypatch.setenv("PODCAST_RELAY_VERSION", "9.9.9")
    assert read_relay_version() == "9.9.9"
    monkeypatch.delenv("PODCAST_RELAY_VERSION", raising=False)

    monkeypatch.setenv("PODCAST_RELAY_GIT_SHA", "abc123def")
    assert read_relay_git_sha() == "abc123def"
    monkeypatch.delenv("PODCAST_RELAY_GIT_SHA", raising=False)
    assert read_relay_git_sha() is None


def test_offline_share_returns_503_html():
    client = TestClient(create_relay_app())
    resp = client.get("/r/unknown-token")
    assert resp.status_code == 503
    assert "host offline" in resp.text.lower()
    assert "text/html" in (resp.headers.get("content-type") or "")


def test_offline_api_review_returns_503():
    client = TestClient(create_relay_app())
    resp = client.get("/api/review/unknown-token/project")
    assert resp.status_code == 503
    assert resp.headers.get("content-type", "").startswith("application/json")
    body = resp.json()
    assert body["detail"] == "host offline"
    assert "podcast tunnel" in body["message"]


def test_offline_mcp_returns_503():
    client = TestClient(create_relay_app())
    resp = client.get("/mcp/unknown-token")
    assert resp.status_code == 503
    assert resp.headers.get("content-type", "").startswith("application/json")
    assert resp.json()["detail"] == "host offline"


def test_mcp_path_forbidden_without_capability(monkeypatch):
    """Relay should 403 /mcp/* for tokens that lack the mcp capability."""
    monkeypatch.setenv("PODCAST_RELAY_ALLOW_OPEN_TUNNEL", "1")
    monkeypatch.delenv("PODCAST_RELAY_HOST_TOKENS", raising=False)
    app = create_relay_app()
    state = app.state.relay

    session = TunnelSession(host_id="h1", websocket=None)  # type: ignore[arg-type]
    asyncio.run(state.register_tunnel(session))
    asyncio.run(
        state.update_shares(
            "h1",
            [{"token": "view-only", "capabilities": ["play", "view"]}],
        )
    )

    client = TestClient(app)
    resp = client.get("/mcp/view-only")
    assert resp.status_code == 403


def test_protocol_msg_helper():
    m = msg("hello", ok=True)
    assert m == {"type": "hello", "ok": True}


def test_protocol_msg_with_id():
    m = msg("http", id="abc", path="r/")
    assert m["id"] == "abc"
    assert m["path"] == "r/"


def test_read_relay_version_fallback_dev(monkeypatch):
    from podcast_mcp.relay import version as ver_mod

    monkeypatch.delenv("PODCAST_RELAY_VERSION", raising=False)
    monkeypatch.setattr(ver_mod, "_read_version_file", lambda path: None)
    assert ver_mod.read_relay_version() == "0.0.0-dev"


def test_read_version_file_oserror(tmp_path):
    from podcast_mcp.relay.version import _read_version_file

    missing = tmp_path / "nope"
    assert _read_version_file(missing) is None
    empty = tmp_path / "empty"
    empty.write_text("  \n", encoding="utf-8")
    assert _read_version_file(empty) is None
