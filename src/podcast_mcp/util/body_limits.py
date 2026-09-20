"""Request / WebSocket size limits (env-tunable)."""

from __future__ import annotations

import os

from starlette.requests import ClientDisconnect, Request
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

_DEFAULT_RELAY_MAX_BODY = 4 * 1024 * 1024
_DEFAULT_GUI_MAX_BODY = 4 * 1024 * 1024
_DEFAULT_MCP_MAX_BODY = 1 * 1024 * 1024
_DEFAULT_WS_MAX = 16 * 1024 * 1024

# Paths that enforce their own size caps (large audio uploads).
_MEDIA_UPLOAD_SUFFIXES = ("/media/upload", "/daw/media/upload")
_RECORD_UPLOAD_MARKERS = ("/api/record/upload", "/api/rec/")
RECORD_UPLOAD_MAX_PART_BYTES = 5 * 1024 * 1024


def env_max_bytes(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return int(default)
    try:
        return max(1, int(raw))
    except ValueError:
        return int(default)


def relay_max_body_bytes() -> int:
    return env_max_bytes("PODCAST_RELAY_MAX_BODY_BYTES", _DEFAULT_RELAY_MAX_BODY)


def record_upload_max_part_bytes() -> int:
    return env_max_bytes("PODCAST_RECORD_UPLOAD_MAX_PART_BYTES", RECORD_UPLOAD_MAX_PART_BYTES)


def is_record_upload_path(path: str) -> bool:
    normalized = path if path.startswith("/") else f"/{path}"
    return normalized.endswith("/upload") and any(
        marker in normalized for marker in _RECORD_UPLOAD_MARKERS
    )


def gui_max_body_bytes() -> int:
    return env_max_bytes("PODCAST_GUI_MAX_BODY_BYTES", _DEFAULT_GUI_MAX_BODY)


def remote_mcp_max_body_bytes() -> int:
    return env_max_bytes("PODCAST_REMOTE_MCP_MAX_BODY_BYTES", _DEFAULT_MCP_MAX_BODY)


def relay_ws_max_size() -> int:
    return env_max_bytes("PODCAST_RELAY_WS_MAX_SIZE", _DEFAULT_WS_MAX)


class BodyTooLarge(Exception):
    def __init__(self, limit: int) -> None:
        self.limit = limit
        super().__init__(f"body exceeds {limit} bytes")


def content_length_too_large(request: Request, limit: int) -> bool:
    raw = request.headers.get("content-length")
    if raw is None:
        return False
    try:
        return int(raw) > limit
    except ValueError:
        return True


def _header_value(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers") or ():
        if key.lower() == name:
            return value.decode("latin-1")
    return None


def _content_length_exceeds(scope: Scope, limit: int) -> bool | None:
    """Return True if CL exceeds limit, False if under, None if header absent."""
    raw = _header_value(scope, b"content-length")
    if raw is None:
        return None
    try:
        return int(raw) > limit
    except ValueError:
        return True


async def read_body_capped(request: Request, limit: int) -> bytes:
    """Read at most ``limit`` bytes; raise ``BodyTooLarge`` if exceeded."""
    if content_length_too_large(request, limit):
        raise BodyTooLarge(limit)
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise BodyTooLarge(limit)
        chunks.append(chunk)
    return b"".join(chunks)


async def _receive_body_capped(receive: Receive, limit: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            raise ClientDisconnect()
        if message["type"] != "http.request":
            continue
        chunk = message.get("body", b"") or b""
        total += len(chunk)
        if total > limit:
            raise BodyTooLarge(limit)
        chunks.append(chunk)
        if not message.get("more_body"):
            break
    return b"".join(chunks)


def _replay_receive(body: bytes) -> Receive:
    sent = False

    async def receive() -> Message:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}

    return receive


def payload_too_large_response(limit: int) -> JSONResponse:
    return JSONResponse(
        {"detail": "request body too large", "limit_bytes": limit},
        status_code=413,
    )


class MaxBodySizeMiddleware:
    """Reject mutating requests whose body exceeds ``limit`` (pure ASGI).

    Checks ``Content-Length`` when present; otherwise streams and buffers up to
    ``limit`` so chunked requests cannot bypass the cap, then replays the body
    via a wrapped ``receive``. Media upload routes enforce ``PODCAST_GUI_MEDIA_*``
    caps themselves.
    """

    def __init__(self, app: ASGIApp, *, limit: int) -> None:
        self.app = app
        self.limit = int(limit)

    def _is_media_upload(self, path: str) -> bool:
        if any(path.endswith(suffix) for suffix in _MEDIA_UPLOAD_SUFFIXES):
            return True
        return is_record_upload_path(path)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        method = scope.get("method", "GET")
        path = scope.get("path", "") or ""
        if method not in {"POST", "PUT", "PATCH"} or self._is_media_upload(path):
            await self.app(scope, receive, send)
            return

        cl_over = _content_length_exceeds(scope, self.limit)
        if cl_over is True:
            await payload_too_large_response(self.limit)(scope, receive, send)
            return
        if cl_over is False:
            await self.app(scope, receive, send)
            return

        try:
            body = await _receive_body_capped(receive, self.limit)
        except BodyTooLarge as exc:
            await payload_too_large_response(exc.limit)(scope, receive, send)
            return
        await self.app(scope, _replay_receive(body), send)
