"""JSON messages between relay and host tunnel client."""

from __future__ import annotations

from typing import Any, Literal
from uuid import uuid4

# Bump on breaking frame shape changes; clients negotiate via hello.protocol_version.
PROTOCOL_VERSION = 1

MsgType = Literal[
    "hello",
    "register",
    "http",
    "http_response",
    "ws_open",
    "ws_data",
    "ws_close",
    "ping",
    "pong",
    "error",
]


def new_id() -> str:
    return uuid4().hex


def msg(
    type: MsgType,
    *,
    id: str | None = None,
    **payload: Any,
) -> dict[str, Any]:
    out: dict[str, Any] = {"type": type, **payload}
    if id is not None:
        out["id"] = id
    return out
