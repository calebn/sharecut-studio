"""A debug-build request log for the embedded engine (#3810).

One line per request: the method, the path without its query string and with any share-link
token replaced, the response status and whether the query string was empty. A WebSocket accept is one line with the method ``WEBSOCKET``
and status 101. No query string, header, cookie or body is read, so the single-use exchange code
never reaches the file. It runs only when ``PODCAST_ENGINE_DEBUG_BUILD`` and
``PODCAST_ENGINE_REQUEST_AUDIT`` are both ``1``, which the iOS host sets only in a debug build
(docs/desktop-packaging.md § iOS app).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from podcast_mcp import settings
from podcast_mcp.util import host_platform
from podcast_mcp.util.redact import redact_share_paths

log = logging.getLogger(__name__)

AUDIT_FILE_NAME = "request-audit.jsonl"
DEBUG_BUILD_VARIABLE = "PODCAST_ENGINE_DEBUG_BUILD"
AUDIT_VARIABLE = "PODCAST_ENGINE_REQUEST_AUDIT"
WEBSOCKET_ACCEPTED = 101
WEBSOCKET_REFUSED = 403


def audit_path() -> Path:
    return host_platform.data_roots().log_dirs[0] / AUDIT_FILE_NAME


def enabled() -> bool:
    """True only when the host says it is a debug build and asks for the audit."""
    asked = settings.flag(AUDIT_VARIABLE)
    if asked and not settings.flag(DEBUG_BUILD_VARIABLE):
        log.warning("The request audit was asked for outside a debug build; it stays off.")
        return False
    return asked


class RequestAudit:
    """ASGI middleware that appends one JSON line per HTTP response start and WebSocket outcome."""

    def __init__(self, app: Any, path: Path) -> None:
        self._app = app
        path.parent.mkdir(parents=True, exist_ok=True)
        # A logger per file: its handler serializes writes, and mode "w" starts each run empty.
        self._out = logging.getLogger(f"{__name__}.{path}")
        self._out.propagate = False
        self._out.setLevel(logging.INFO)
        for old in list(self._out.handlers):
            self._out.removeHandler(old)
            old.close()
        handler = logging.FileHandler(path, mode="w", encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(message)s"))
        self._out.addHandler(handler)

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        kind = scope["type"]
        if kind not in ("http", "websocket"):
            await self._app(scope, receive, send)
            return
        method = "WEBSOCKET" if kind == "websocket" else scope["method"]
        path = redact_share_paths(scope["path"])
        query_empty = not scope.get("query_string")
        accepted = False

        async def audited(message: Any) -> None:
            nonlocal accepted
            event = message["type"]
            if event == "http.response.start":
                self._record(method, path, message["status"], query_empty)
            elif event == "websocket.accept":
                accepted = True
                self._record(method, path, WEBSOCKET_ACCEPTED, query_empty)
            elif event == "websocket.close" and not accepted:
                self._record(method, path, WEBSOCKET_REFUSED, query_empty)
            await send(message)

        await self._app(scope, receive, audited)

    def _record(self, method: str, path: str, status: int, query_empty: bool) -> None:
        self._out.info(
            json.dumps(
                {"method": method, "path": path, "status": status, "query_empty": query_empty}
            )
        )


def install(app: Any) -> None:
    """Put the audit in front of ``app``'s routes when the host enabled it, before it first serves.

    It is a middleware of the app, not a wrapper around it: the Origin check and other state
    live on ``app.state``, which a wrapper would hide from the server that records the port there.
    """
    if enabled():
        app.add_middleware(RequestAudit, path=audit_path())
