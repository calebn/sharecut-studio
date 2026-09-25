"""Reject forged Host / Origin on host GUI APIs (DNS-rebind / CSRF).

Loopback TCP peers are not enough: a public page that rebinds to
``127.0.0.1:8765`` still has peer ``127.0.0.1`` while ``Host`` is the attacker
name. Tunnel→GUI requests use ``Host`` from ``local_gui_url`` (loopback) and
typically have no browser ``Origin``.
"""

from __future__ import annotations

from urllib.parse import urlparse

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from podcast_mcp.services.session_sync.authz import is_loopback_host

# Host-only mutating (and related) surfaces — share/review routes are token-scoped.
_PROTECTED_PREFIXES = (
    "/api/project",
    "/api/pipeline",
    "/api/export",
    "/api/bootstrap",
    "/api/diagnostics",
    "/api/media",
    "/api/audio",
    "/api/peaks",
    "/api/waveform",
    "/api/waveform-snap",
    "/api/history",
    "/api/document",
    "/api/transcript",
    "/api/session",
    "/api/comments",
    "/api/shares",
    "/api/record",
)

# Starlette TestClient default Host; not reachable via DNS rebind on a real bind.
_TEST_HOSTS = frozenset({"testserver"})


def _host_without_port(host_header: str) -> str:
    raw = (host_header or "").strip().lower()
    if not raw:
        return ""
    # IPv6 in brackets: [::1]:8765
    if raw.startswith("["):
        end = raw.find("]")
        if end != -1:
            return raw[1:end]
    if raw.count(":") == 1:
        return raw.rsplit(":", 1)[0]
    return raw


def host_header_is_allowed(host_header: str) -> bool:
    host = _host_without_port(host_header)
    if not host:
        return False
    if is_loopback_host(host):
        return True
    return host in _TEST_HOSTS


def origin_is_loopback(origin: str | None) -> bool:
    """True when Origin is absent (non-browser / tunnel) or a loopback http(s) URL."""
    if origin is None or not str(origin).strip():
        return True
    parsed = urlparse(str(origin).strip())
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").strip().lower()
    return is_loopback_host(host)


def path_requires_host_binding(path: str) -> bool:
    p = path.split("?", 1)[0]
    return any(p == prefix or p.startswith(prefix + "/") for prefix in _PROTECTED_PREFIXES)


def websocket_host_binding_denied(websocket) -> str | None:
    """Return a close reason when Host/Origin/Referer fail for host GUI websockets.

    ``BaseHTTPMiddleware`` does not run for WebSocket scopes, so session/document
    WS handlers must call this before ``accept``.
    """
    host = websocket.headers.get("host") or ""
    if not host_header_is_allowed(host):
        return "invalid Host header for host GUI"
    origin = websocket.headers.get("origin")
    if not origin_is_loopback(origin):
        return "Origin not allowed for host GUI"
    referer = websocket.headers.get("referer")
    if referer and not origin_is_loopback(referer):
        return "Referer not allowed for host GUI"
    return None


class HostOriginBindingMiddleware(BaseHTTPMiddleware):
    """Block DNS-rebind Host and non-loopback browser Origin on host APIs."""

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path
        if path_requires_host_binding(path):
            host = request.headers.get("host") or ""
            if not host_header_is_allowed(host):
                return JSONResponse(
                    {"detail": "invalid Host header for host GUI"},
                    status_code=400,
                )
            origin = request.headers.get("origin")
            if not origin_is_loopback(origin):
                return JSONResponse(
                    {"detail": "Origin not allowed for host GUI"},
                    status_code=403,
                )
            referer = request.headers.get("referer")
            if referer and not origin_is_loopback(referer):
                return JSONResponse(
                    {"detail": "Referer not allowed for host GUI"},
                    status_code=403,
                )
        return await call_next(request)
