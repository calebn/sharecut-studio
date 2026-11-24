"""Security headers on proxied guest responses: the CSP policy, its switch, and nosniff."""

from __future__ import annotations

import base64
from pathlib import Path

import httpx
import pytest
from httpx import ASGITransport, AsyncClient
from tests.relay_enroll import enable_enrollment

from podcast_mcp.util.relay_protocol.share_claims import attach_share_claims
from podcast_relay.app import create_relay_app
from podcast_relay.guest_headers import guest_csp, is_html, proxied_security_headers
from podcast_relay.routes.tunnel import _ingest_http_response
from podcast_relay.state import TunnelSession

ORIGIN = "https://share.example.com"
POLICY = (
    "form-action 'none'; connect-src 'self' wss://share.example.com; "
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
)


def test_the_policy_blocks_forms_plugins_base_and_framing_and_names_its_socket_origin() -> None:
    assert guest_csp(ORIGIN) == POLICY
    assert guest_csp("http://127.0.0.1:8081") == POLICY.replace(
        "wss://share.example.com", "ws://127.0.0.1:8081"
    )


@pytest.mark.parametrize(
    ("content_type", "html"),
    [
        ("text/html", True),
        ("text/html; charset=utf-8", True),
        ("TEXT/HTML", True),
        ("application/xhtml+xml", False),
        ("audio/mpeg", False),
        ("application/json", False),
        (None, False),
    ],
)
def test_only_html_gets_the_policy_and_every_response_gets_nosniff(
    monkeypatch: pytest.MonkeyPatch, content_type: str | None, html: bool
) -> None:
    monkeypatch.delenv("PODCAST_RELAY_CSP_ENFORCE", raising=False)

    headers = proxied_security_headers(content_type, ORIGIN)

    assert is_html(content_type) is html
    expected = {"X-Content-Type-Options": "nosniff"}
    if html:
        expected["Content-Security-Policy-Report-Only"] = POLICY
    assert headers == expected


def test_the_switch_enforces_the_same_policy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PODCAST_RELAY_CSP_ENFORCE", "1")

    assert proxied_security_headers("text/html", ORIGIN) == {
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": POLICY,
    }


async def _proxied_page(app) -> httpx.Response:
    class Host:
        async def send_json(self, data):
            await _ingest_http_response(
                session.pending[data["id"]],
                {
                    "status": 200,
                    "headers": {
                        "Content-Type": "text/html",
                        "Content-Security-Policy": "default-src *",
                        "X-Content-Type-Options": "sniff",
                    },
                    "body_b64": base64.b64encode(b"<p>hi</p>").decode(),
                },
            )

    meter = app.state.relay.meter
    session = TunnelSession(
        host_id="h1",
        websocket=Host(),  # type: ignore[arg-type]
        host_token="secret",
        meter=meter.session(install_id="", host_token="secret") if meter else None,
    )
    await app.state.relay.register_tunnel(session)
    rows = attach_share_claims(
        [{"token": "tok", "capabilities": ["view"]}], host_id="h1", secret="secret"
    )
    await app.state.relay.update_shares("h1", rows, expected_session=session)

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="https://share.example.com"
    ) as http:
        return await http.get("/r/tok/")


@pytest.mark.asyncio
async def test_a_proxied_page_carries_the_policy_and_drops_the_host_s_own(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("PODCAST_RELAY_RATE_LIMIT", "0")
    monkeypatch.delenv("PODCAST_RELAY_CSP_ENFORCE", raising=False)
    enable_enrollment(monkeypatch, tmp_path, PODCAST_RELAY_HOST_TOKENS="secret")

    res = await _proxied_page(create_relay_app())

    assert res.headers["content-security-policy-report-only"] == POLICY
    assert "content-security-policy" not in res.headers
    assert res.headers["x-content-type-options"] == "nosniff"


@pytest.mark.asyncio
async def test_a_relay_with_no_signing_key_adds_no_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PODCAST_RELAY_HOST_TOKENS", "secret")
    monkeypatch.setenv("PODCAST_RELAY_RATE_LIMIT", "0")

    res = await _proxied_page(create_relay_app())

    assert res.status_code == 200
    assert {"content-security-policy-report-only", "x-content-type-options"}.isdisjoint(res.headers)
