"""Clickjacking / MIME-sniffing / CSP headers for the host GUI."""

from __future__ import annotations

import re

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from podcast_mcp.util import host_platform

GUI_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self'; "
    "connect-src 'self' ws://127.0.0.1:* ws://localhost:* "
    "http://127.0.0.1:* http://localhost:*; "
    "media-src 'self' blob:; "
    "worker-src 'self' blob:; "
    "frame-ancestors 'none'; "
    "object-src 'none'; "
    "base-uri 'self'"
)


def self_only_csp(listen_port: int | None) -> str:
    """``GUI_CSP`` for a host whose loopback is not trusted: connect to this origin and nothing else."""
    connect = "'self'" if listen_port is None else f"'self' ws://127.0.0.1:{listen_port}"
    return re.sub(r"connect-src [^;]*;", f"connect-src {connect};", GUI_CSP)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Attach CSP, X-Frame-Options, and nosniff on every GUI response.

    A host whose loopback is not trusted also narrows ``connect-src`` to its own port and sends
    no Referer, so no URL leaves the engine's origin.
    """

    async def dispatch(self, request: Request, call_next) -> Response:
        response = await call_next(request)
        if host_platform.current().loopback_is_trusted:
            response.headers.setdefault("Content-Security-Policy", GUI_CSP)
        else:
            port = getattr(request.app.state, "listen_port", None)
            response.headers.setdefault("Content-Security-Policy", self_only_csp(port))
            response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        return response
