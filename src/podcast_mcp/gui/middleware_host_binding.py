"""Reject forged Host / Origin on host GUI APIs (DNS-rebind / CSRF).

Loopback TCP peers are not enough: a public page that rebinds to
``127.0.0.1:8765`` still has peer ``127.0.0.1`` while ``Host`` is the attacker
name. Tunnel→GUI requests use ``Host`` from ``local_gui_url`` (loopback) and
typically have no browser ``Origin``.

A host whose loopback is not trusted holds its credential in a cookie, and a cookie goes to every
loopback port. So there an Origin or Referer must name this server's own port, every ``/api/``
route is bound (not only the listed prefixes), and only the guest routes are left out.
"""

from __future__ import annotations

from urllib.parse import urlparse

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from podcast_mcp.services.session_sync import is_loopback_host
from podcast_mcp.util import host_platform
from podcast_mcp.util.host_session_wire import EXCHANGE_PATH

# Host-only mutating (and related) surfaces — share/review routes are token-scoped.
_PROTECTED_PREFIXES = (
    "/api/project",
    "/api/projects",
    "/api/pending-edits",
    "/api/pipeline",
    "/api/export",
    "/api/handoff",
    "/api/bootstrap",
    "/api/diagnostics",
    "/api/media",
    "/api/audio",
    "/api/waveform",
    "/api/waveform-snap",
    "/api/history",
    "/api/document",
    "/api/transcript",
    "/api/session",
    "/api/comments",
    "/api/shares",
    "/api/record",
    "/api/feed",
    "/api/speaker",
    "/api/boundary",
    "/api/session-suggestion",
    "/api/pending-preview",
    "/api/range-audio",
    "/api/clips",
    "/api/tunnel",
)

# Share guests reach these through a tunnel, with their own origins; their credential is the
# share token in the path, never the owner cookie.
_GUEST_PREFIXES = ("/api/review/", "/api/rec/")

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


def origin_is_self(origin: str | None, listen_port: int | None) -> bool:
    """True when *origin* is absent or exactly ``http://127.0.0.1:<listen_port>``.

    A Referer may carry a path after the port. Nothing else passes: not another loopback port,
    not ``localhost``, not a name with user info.
    """
    if origin is None or not str(origin).strip():
        return True
    if listen_port is None:
        return False
    parsed = urlparse(str(origin).strip())
    return parsed.scheme == "http" and parsed.netloc == f"127.0.0.1:{listen_port}"


def _origin_allowed(origin: str | None, connection) -> bool:
    if host_platform.current().loopback_is_trusted:
        return origin_is_loopback(origin)
    return origin_is_self(origin, getattr(connection.app.state, "listen_port", None))


def path_requires_host_binding(path: str) -> bool:
    p = path.split("?", 1)[0]
    return any(p == prefix or p.startswith(prefix + "/") for prefix in _PROTECTED_PREFIXES)


def _is_bound(path: str) -> bool:
    if path_requires_host_binding(path):
        return True
    if host_platform.current().loopback_is_trusted:
        return False
    return path.startswith("/api/") and not path.startswith(_GUEST_PREFIXES)


def _is_exchange_navigation(path: str) -> bool:
    """The shell's first request comes from outside the engine's origin; its one-time code is the proof."""
    return path == EXCHANGE_PATH and not host_platform.current().loopback_is_trusted


def websocket_host_binding_denied(websocket) -> str | None:
    """Return a close reason when Host/Origin/Referer fail for host GUI websockets.

    ``BaseHTTPMiddleware`` does not run for WebSocket scopes, so session/document
    WS handlers must call this before ``accept``.
    """
    host = websocket.headers.get("host") or ""
    if not host_header_is_allowed(host):
        return "invalid Host header for host GUI"
    origin = websocket.headers.get("origin")
    if not _origin_allowed(origin, websocket):
        return "Origin not allowed for host GUI"
    referer = websocket.headers.get("referer")
    if referer and not _origin_allowed(referer, websocket):
        return "Referer not allowed for host GUI"
    return None


class HostOriginBindingMiddleware(BaseHTTPMiddleware):
    """Block DNS-rebind Host and non-loopback browser Origin on host APIs."""

    async def dispatch(self, request: Request, call_next) -> Response:
        path = request.url.path
        if _is_bound(path):
            host = request.headers.get("host") or ""
            if not host_header_is_allowed(host):
                return JSONResponse(
                    {"detail": "invalid Host header for host GUI"},
                    status_code=400,
                )
            if not _is_exchange_navigation(path):
                origin = request.headers.get("origin")
                if not _origin_allowed(origin, request):
                    return JSONResponse(
                        {"detail": "Origin not allowed for host GUI"},
                        status_code=403,
                    )
                referer = request.headers.get("referer")
                if referer and not _origin_allowed(referer, request):
                    return JSONResponse(
                        {"detail": "Referer not allowed for host GUI"},
                        status_code=403,
                    )
        return await call_next(request)
