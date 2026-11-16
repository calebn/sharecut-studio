"""Keep link tokens out of uvicorn's request and WebSocket log lines.

uvicorn writes the full path and query of every request to ``uvicorn.access`` and of every
WebSocket accept, refusal and close to ``uvicorn.error``, whatever ``access_log`` says. Both
the desktop sidecar log and the embedded engine log are bundled for support, so the filter
rewrites the line before any handler formats it.
"""

from __future__ import annotations

import logging
from typing import Any

from podcast_mcp.util.redact import redact_share_paths

UVICORN_LOGGERS = ("uvicorn.access", "uvicorn.error", "uvicorn.asgi")


def _scrub(value: Any) -> Any:
    """The redacted text of ``value``; a route that carries a token also loses its query.

    The query of a guest WebSocket holds the guest's name and client id.
    """
    if isinstance(value, dict):
        return _scrub_scope(value)
    if not isinstance(value, str):
        return value
    path, separator, _query = value.partition("?")
    redacted_path = redact_share_paths(path)
    if separator and redacted_path != path:
        return redacted_path
    return redact_share_paths(value)


def _scrub_scope(scope: dict[Any, Any]) -> Any:
    """An ASGI scope (logged at trace level) as text without its token, or itself if clean."""
    text = repr(scope)
    redacted = redact_share_paths(text)
    if redacted == text:
        return scope
    return redact_share_paths(repr({**scope, "query_string": b""}))


class ShareTokenFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = _scrub(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(_scrub(arg) for arg in record.args)
        return True


def install() -> None:
    """Put one filter on each uvicorn logger (idempotent)."""
    for name in UVICORN_LOGGERS:
        target = logging.getLogger(name)
        if not any(isinstance(f, ShareTokenFilter) for f in target.filters):
            target.addFilter(ShareTokenFilter())
