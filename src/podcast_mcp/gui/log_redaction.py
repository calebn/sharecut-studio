"""Keep link tokens out of uvicorn's request and WebSocket log lines.

uvicorn writes the full path and query of every request to ``uvicorn.access`` and of every
WebSocket accept, refusal and close to ``uvicorn.error``, whatever ``access_log`` says. Both
the desktop sidecar log and the embedded engine log are bundled for support, so the filter
rewrites the line before any handler formats it.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import unquote

from podcast_mcp.util.redact import redact_share_paths

_BOUNDARY = re.compile(r"[\s'\"()\[\]{},]")
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
    kept: list[str] = []
    position = 0
    while (mark := text.find("?", position)) >= 0:
        start = max((m.end() for m in _BOUNDARY.finditer(text, position, mark)), default=position)
        route = text[start:mark]
        if redact_share_paths(route) == route:
            kept.append(text[position : mark + 1])
            position = mark + 1
            continue
        kept.append(text[position:mark])
        end = _BOUNDARY.search(text, mark)
        position = end.start() if end else len(text)
    kept.append(text[position:])
    return redact_share_paths("".join(kept))


def _without_query(value: Any) -> Any:
    if isinstance(value, Mapping) and "query_string" in value:
        return {**value, "query_string": b""}
    return value


def _scrub(value: Any) -> Any:
    """The redacted text of ``value``; a route that carries a token also loses its query."""
    if isinstance(value, str):
        plain = str.__str__(value)
        decoded = _decoded(plain)
        from_decoded = _redact_route(decoded)
        from_plain = _redact_route(plain)
        if from_decoded != decoded and _decoded(from_plain) != from_decoded:
            return from_decoded
        if from_plain != plain:
            return from_plain
        return plain
    text = _text(value)
    if text is None or redact_share_paths(text) == text:
        return value
    return _redact_route(_text(_without_query(value)) or text)


def _changed(new: Any, old: Any) -> bool:
    if isinstance(old, str):
        return new != str.__str__(old)
    return new is not old


def _fail_closed(record: logging.LogRecord) -> None:
    try:
        text = record.getMessage()
    except Exception:
        if isinstance(record.msg, str):
            record.msg = _redact_route(record.msg)
            record.args = ()
        return
    redacted = _redact_route(text)
    if redacted != text:
        record.msg = redacted
        record.args = ()


class ShareTokenFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = _scrub(record.msg)
            args = record.args
            if isinstance(args, tuple):
                scrubbed_args = tuple(_scrub(arg) for arg in args)
                if any(new is not old for new, old in zip(scrubbed_args, args, strict=True)):
                    args = scrubbed_args
            elif isinstance(args, Mapping):
                scrubbed = {key: _scrub(arg) for key, arg in args.items()}
                if any(_changed(scrubbed[key], arg) for key, arg in args.items()):
                    args = _without_query(scrubbed)
        except Exception:
            _fail_closed(record)
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
