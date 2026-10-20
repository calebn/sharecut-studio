"""ASGI middleware: enforce Restricted / require_sign_in on share API routes."""

from __future__ import annotations

import logging
import re
from collections.abc import Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from podcast_mcp.gui.routes.deps import guard_http_error
from podcast_mcp.gui.routes.guest_errors import guest_http_error
from podcast_mcp.services.collaboration import lookup_share
from podcast_mcp.services.share_auth import require_share_access
from podcast_mcp.util.coded_error import GuardRefusal

log = logging.getLogger(__name__)

_REVIEW_API = re.compile(r"^/api/review/([^/]+)(?:/|$)")
# Claude/custom connectors sometimes append /mcp to the share URL.
_MCP_SHARE_ALIAS = re.compile(r"^/r/([^/]+)/mcp/?$")
# Canonical printed MCP URL on the host GUI / relay.
_MCP_PUBLIC = re.compile(r"^/mcp/([^/]+)(?:/|$)")


class ShareIdentityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        path = request.url.path
        m = _REVIEW_API.match(path) or _MCP_SHARE_ALIAS.match(path) or _MCP_PUBLIC.match(path)
        if m is None or request.method == "OPTIONS":
            return await call_next(request)
        token = m.group(1)
        try:
            row = lookup_share(token, kind="review")
        except KeyError:
            # Let the route return its own 404 / capability errors.
            return await call_next(request)
        except Exception as exc:
            failure = guest_http_error(exc, logger=log, operation="share identity")
            return JSONResponse(
                status_code=failure.status_code,
                content={"detail": failure.detail},
                headers=failure.headers,
            )
        try:
            require_share_access(request, row)
        except GuardRefusal as exc:
            refusal = guard_http_error(exc)
            return JSONResponse(
                status_code=refusal.status_code,
                content={"detail": refusal.detail},
                headers=refusal.headers,
            )
        return await call_next(request)
