"""Tests for relay proxy path routing and capability gates."""

from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from podcast_mcp.relay.app import RelayState, TunnelSession, create_relay_app
from podcast_relay.share_claims import attach_share_claims

_SECRET = "test-host-secret"


def _register_shares(
    state: RelayState,
    *,
    host_id: str,
    token: str,
    capabilities: list[str],
    secret: str = _SECRET,
) -> TunnelSession:
    session = TunnelSession(host_id=host_id, websocket=None, host_token=secret)  # type: ignore[arg-type]
    asyncio.run(state.register_tunnel(session))
    rows = attach_share_claims(
        [{"token": token, "capabilities": capabilities}],
        host_id=host_id,
        secret=secret,
    )
    asyncio.run(state.update_shares(host_id, rows))
    return session


def _app_with_view_only_session(monkeypatch) -> tuple[object, str]:
    """Return (TestClient, token) with a view-only tunnel session registered."""
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", _SECRET)
    app = create_relay_app()
    state: RelayState = app.state.relay
    _register_shares(
        state,
        host_id="h1",
        token="view-tok",
        capabilities=["play", "view"],
    )
    return TestClient(app), "view-tok"


def _app_with_mcp_session(monkeypatch) -> tuple[object, str]:
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", _SECRET)
    app = create_relay_app()
    state: RelayState = app.state.relay
    _register_shares(
        state,
        host_id="h1",
        token="mcp-tok",
        capabilities=["play", "comment", "mcp"],
    )
    return TestClient(app), "mcp-tok"


def test_view_only_mcp_path_forbidden(monkeypatch):
    client, tok = _app_with_view_only_session(monkeypatch)
    resp = client.get(f"/mcp/{tok}")
    assert resp.status_code == 403
    assert "mcp" in resp.json().get("detail", "").lower()


def test_mcp_capable_token_relay_allows_mcp(monkeypatch):
    """Relay does not block /mcp/* for tokens that have the mcp capability."""
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", _SECRET)
    app = create_relay_app()
    state: RelayState = app.state.relay
    _register_shares(
        state,
        host_id="h1",
        token="mcp-tok2",
        capabilities=["play", "comment", "mcp"],
    )
    found = state.tunnel_for_token("mcp-tok2")
    assert found is not None
    caps = found.capabilities.get("mcp-tok2") or []
    assert "mcp" in caps


def test_share_root_offline_503():
    client = TestClient(create_relay_app())
    resp = client.get("/r/no-host-connected")
    assert resp.status_code == 503
    assert "offline" in resp.text.lower()
    assert "var(--color-text-primary)" in resp.text
    assert "color:#222" not in resp.text.replace(" ", "")


def test_offline_page_loads_css_files_not_python_hex():
    from podcast_relay.offline import offline_page

    html = offline_page(title="T", heading="H", body_html="<p>body</p>")
    assert "<title>T</title>" in html
    assert "<h1>H</h1>" in html
    assert "<p>body</p>" in html
    assert "var(--color-bg-canvas)" in html
    assert "color:#222" not in html.replace(" ", "")
    assert "--color-text-primary" in html


def test_api_review_root_offline_503():
    client = TestClient(create_relay_app())
    resp = client.get("/api/review/no-host-connected/project")
    assert resp.status_code == 503
    assert resp.json()["detail"] == "host offline"


def test_rec_root_offline_503_record_copy():
    client = TestClient(create_relay_app())
    resp = client.get("/rec/no-host-connected")
    assert resp.status_code == 503
    assert "Studio not open yet" in resp.text
    assert "var(--color-text-primary)" in resp.text
    assert "color:#222" not in resp.text.replace(" ", "")


def test_api_rec_offline_503_json():
    client = TestClient(create_relay_app())
    resp = client.get("/api/rec/no-host-connected/bootstrap")
    assert resp.status_code == 503
    assert resp.json()["detail"] == "host offline"


def test_relay_rejects_traversal_under_rec(monkeypatch):
    client, tok = _app_with_view_only_session(monkeypatch)
    resp = client.get(f"/rec/{tok}/assets/%2e%2e/%2e%2e/api/pipeline/run")
    assert resp.status_code == 400
    assert resp.json()["detail"] == "unsafe proxy path"


def test_mcp_path_with_sub_offline_503():
    client = TestClient(create_relay_app())
    resp = client.post("/mcp/no-host-connected/mcp")
    assert resp.status_code == 503
    assert resp.json()["detail"] == "host offline"


def test_relay_state_stored_on_app():
    app = create_relay_app()
    assert hasattr(app.state, "relay")
    state: RelayState = app.state.relay
    assert isinstance(state, RelayState)


def test_relay_rejects_path_traversal_before_proxy(monkeypatch):
    client, tok = _app_with_view_only_session(monkeypatch)
    # Use percent-encoding so HTTP clients do not normalize away ``..``.
    resp = client.get(f"/r/{tok}/assets/%2e%2e/%2e%2e/api/pipeline/run")
    assert resp.status_code == 400
    assert resp.json()["detail"] == "unsafe proxy path"


def test_relay_rejects_encoded_traversal_on_api_review(monkeypatch):
    client, tok = _app_with_view_only_session(monkeypatch)
    resp = client.get(f"/api/review/{tok}/%2e%2e/%2e%2e/api/project")
    assert resp.status_code == 400
    assert resp.json()["detail"] == "unsafe proxy path"


def test_relay_rejects_oversize_body(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_MAX_BODY_BYTES", "64")
    monkeypatch.setenv("PODCAST_RELAY_RATE_LIMIT", "0")
    client, tok = _app_with_mcp_session(monkeypatch)
    resp = client.post(
        f"/mcp/{tok}/mcp",
        content=b"x" * 200,
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 413
    assert resp.json()["detail"] == "request body too large"


def test_relay_record_upload_uses_part_cap(monkeypatch):
    monkeypatch.setenv("PODCAST_RELAY_MAX_BODY_BYTES", "64")
    monkeypatch.setenv("PODCAST_RELAY_RATE_LIMIT", "0")
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", _SECRET)
    app = create_relay_app()
    state: RelayState = app.state.relay
    _register_shares(
        state,
        host_id="h1",
        token="rec-tok",
        capabilities=["join", "monitor"],
    )
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.post(
        "/api/rec/rec-tok/upload?take_index=0&segment_index=0&part_seq=0",
        content=b"x" * 200,
        headers={"content-type": "application/octet-stream"},
    )
    assert resp.status_code != 413
