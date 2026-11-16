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


def _decoded(text: str) -> str:
    for _ in range(3):
        text = unquote(text)
    return text


def _text(value: object) -> str | None:
    try:
        return _decoded(str(value))
    except Exception:
        return None


def _redact_route(text: str) -> str:
    path, separator, _query = text.partition("?")
    redacted_path = redact_share_paths(path)
    if separator and redacted_path != path:
        return redacted_path
    return redact_share_paths(text)


def _scrub(value: Any) -> Any:
    """The redacted text of ``value``; a route that carries a token also loses its query.

    The query of a guest WebSocket holds the guest's name and client id. A value that is not
    text is kept as it is unless its text, once percent-decoded, holds a token.
    """
    if isinstance(value, str):
        plain = str.__str__(value)
        redacted = _redact_route(plain)
        if redacted == plain:
            decoded = _decoded(plain)
            redacted = _redact_route(decoded)
            if redacted == decoded:
                return value if type(value) is str else plain
        return redacted
    text = _text(value)
    if text is None or redact_share_paths(text) == text:
        return value
    if isinstance(value, Mapping) and "query_string" in value:
        text = _text({**value, "query_string": b""}) or text
    return redact_share_paths(text)


def _holds_token(value: Any) -> bool:
    text = _decoded(str.__str__(value)) if isinstance(value, str) else _text(value)
    return text is not None and redact_share_paths(text) != text


class ShareTokenFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        """Scrub the record in place; a record that cannot be read is left as it was."""
        try:
            msg = _scrub(record.msg)
            args = record.args
            if isinstance(args, tuple):
                scrubbed_args = tuple(_scrub(arg) for arg in args)
                if any(new is not old for new, old in zip(scrubbed_args, args, strict=True)):
                    args = scrubbed_args
            elif isinstance(args, Mapping) and any(_holds_token(a) for a in args.values()):
                scrubbed = {key: _scrub(arg) for key, arg in args.items()}
                if "query_string" in scrubbed:
                    scrubbed["query_string"] = b""
                args = scrubbed
        except Exception:
            return True
        record.msg = msg
        record.args = args
        return True


def install() -> None:
    """Put one filter on each uvicorn logger (idempotent)."""
    for name in UVICORN_LOGGERS:
        target = logging.getLogger(name)
        if not any(isinstance(f, ShareTokenFilter) for f in target.filters):
            target.addFilter(ShareTokenFilter())
