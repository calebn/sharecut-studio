"""Keep link tokens out of uvicorn's request and WebSocket log lines.

uvicorn writes the full path and query of every request to ``uvicorn.access`` and of every
WebSocket accept, refusal and close to ``uvicorn.error``, whatever ``access_log`` says. Both
the desktop sidecar log and the embedded engine log are bundled for support, so the filter
rewrites the line before any handler formats it.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any
from urllib.parse import unquote

from podcast_mcp.util.redact import redact_share_paths

UVICORN_LOGGERS = ("uvicorn.access", "uvicorn.error", "uvicorn.asgi")


def _text(value: object) -> str | None:
    try:
        return unquote(str(value))
    except Exception:
        return None


def _scrub(value: Any) -> Any:
    """The redacted text of ``value``; a route that carries a token also loses its query.

    The query of a guest WebSocket holds the guest's name and client id. A value that is not
    text is kept as it is unless its text, once percent-decoded, holds a token.
    """
    if isinstance(value, str):
        path, separator, _query = value.partition("?")
        redacted_path = redact_share_paths(path)
        if separator and redacted_path != path:
            return redacted_path
        redacted = redact_share_paths(value)
        return value if redacted == value else redacted
    text = _text(value)
    if text is None or redact_share_paths(text) == text:
        return value
    if isinstance(value, Mapping) and "query_string" in value:
        text = _text({**value, "query_string": b""}) or text
    return redact_share_paths(text)


class ShareTokenFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = _scrub(record.msg)
        if isinstance(record.args, tuple):
            scrubbed_args = tuple(_scrub(arg) for arg in record.args)
            if any(new is not old for new, old in zip(scrubbed_args, record.args, strict=True)):
                record.args = scrubbed_args
        elif isinstance(record.args, Mapping):
            scrubbed = {key: _scrub(arg) for key, arg in record.args.items()}
            if any(scrubbed[key] is not arg for key, arg in record.args.items()):
                if "query_string" in scrubbed:
                    scrubbed["query_string"] = b""
                record.args = scrubbed
        return True


def install() -> None:
    """Put one filter on each uvicorn logger (idempotent)."""
    for name in UVICORN_LOGGERS:
        target = logging.getLogger(name)
        if not any(isinstance(f, ShareTokenFilter) for f in target.filters):
            target.addFilter(ShareTokenFilter())
