"""Keep link tokens out of uvicorn's request and WebSocket log lines.

uvicorn writes the full path and query of every request to ``uvicorn.access`` and of every
WebSocket accept, refusal and close to ``uvicorn.error``, whatever ``access_log`` says; at the
trace level ``uvicorn.asgi`` logs every request's full scope, path and query. The desktop
sidecar log and the embedded engine log are bundled for support, so the filter on all three
loggers rewrites the line before any handler formats it.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from podcast_mcp.util.redact import redact_share_paths

_SCOPE_QUERY = re.compile(r"'query_string': b(?:'[^']*'|\"[^\"]*\")")
UVICORN_LOGGERS = ("uvicorn.access", "uvicorn.error", "uvicorn.asgi")


def _scrub(value: Any) -> Any:
    """The redacted text of ``value``; a route that carries a token also loses its query.

    The query of a guest WebSocket holds the guest's name and client id.
    """
    if not isinstance(value, str):
        if isinstance(value, bool | int | float | None):
            return value
        text = str(value)
        scrubbed = _scrub(text)
        if scrubbed == text:
            return value
        return _SCOPE_QUERY.sub("'query_string': b''", scrubbed)
    path, separator, _query = value.partition("?")
    redacted_path = redact_share_paths(path)
    if separator and redacted_path != path:
        return redacted_path
    return redact_share_paths(value)


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
