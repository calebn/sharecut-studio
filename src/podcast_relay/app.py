"""podcast-relay - TLS-edge reverse tunnel for host-online DAW sharing."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import os
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import (
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    Response,
    StreamingResponse,
)

from podcast_mcp.util.body_limits import (
    BodyTooLarge,
    is_record_upload_path,
    payload_too_large_response,
    read_body_capped,
    record_upload_max_part_bytes,
    relay_max_body_bytes,
    relay_ws_max_size,
)
from podcast_mcp.util.proxy_paths import proxy_path_is_safe
from podcast_mcp.util.ws_limits import GUEST_FRAME_MAX_BYTES
from podcast_relay.limits import (
    check_proxy_rpm,
    check_register,
    get_relay_limiters,
    is_audio_path,
    is_presence_ws_text,
    rate_limit_detail,
    relay_rate_limit_enabled,
)
from podcast_relay.offline import offline_page
from podcast_relay.protocol import msg, new_id
from podcast_relay.version import read_relay_git_sha, read_relay_version

_OFFLINE_HTML = offline_page(
    title="Host offline",
    heading="Host offline",
    body_html=(
        "<p>This share link is valid, but the project host is not connected right now.\n"
        "Ask them to run <code>podcast tunnel</code> and try again.</p>"
    ),
)

_OFFLINE_RECORD_HTML = offline_page(
    title="Studio not open yet",
    heading="Studio not open yet",
    body_html=("<p>The host isn't connected. Keep this link; try again when they are online.</p>"),
)

_HOP_BY_HOP_RESP = frozenset(
    {
        "transfer-encoding",
        "connection",
        # StreamingResponse reassembles tunnel chunks; never forward an upstream
        # Content-Length that may not match the decoded body (HTTP/2 reset).
        "content-length",
    }
)

# Only these response headers may leave the relay toward guests (drop Set-Cookie).
_ALLOWED_RESP_HEADERS = frozenset(
    {
        "content-type",
        "cache-control",
        "accept-ranges",
        "etag",
        "content-disposition",
        "location",
        "content-range",
        "last-modified",
        "vary",
    }
)


async def _ingest_http_response(pending: PendingHttp, data: dict[str, Any]) -> None:
    """Apply one host ``http_response`` frame (possibly chunked) to ``pending``."""
    if not pending.headers_ready.is_set():
        pending.status = int(data.get("status") or 502)
        headers = data.get("headers") or {}
        if not isinstance(headers, dict):
            headers = {}
        pending.headers = {str(k): str(v) for k, v in headers.items()}
        pending.headers_ready.set()

    raw_b64 = data.get("body_b64") or ""
    if raw_b64:
        await pending.queue.put(base64.b64decode(raw_b64))

    if bool(data.get("eof", True)):
        await pending.queue.put(None)
        pending.response = data
        pending.event.set()


def _response_headers(headers: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in headers.items():
        lk = k.lower()
        if lk in _HOP_BY_HOP_RESP:
            continue
        if lk not in _ALLOWED_RESP_HEADERS:
            continue
        out[k] = v
    return out


@dataclass
class PendingHttp:
    headers_ready: asyncio.Event = field(default_factory=asyncio.Event)
    queue: asyncio.Queue[bytes | None] = field(default_factory=asyncio.Queue)
    status: int = 502
    headers: dict[str, str] = field(default_factory=dict)
    # Legacy single-shot fields kept for unit-test helpers.
    event: asyncio.Event = field(default_factory=asyncio.Event)
    response: dict[str, Any] | None = None


@dataclass
class GuestWsStream:
    """One guest↔host WebSocket stream multiplexed on the tunnel."""

    queue: asyncio.Queue[str | None] = field(default_factory=asyncio.Queue)
    close_code: int = 1000


@dataclass
class TunnelSession:
    host_id: str
    websocket: WebSocket
    host_token: str = ""
    share_tokens: set[str] = field(default_factory=set)
    capabilities: dict[str, list[str]] = field(default_factory=dict)
    pending: dict[str, PendingHttp] = field(default_factory=dict)
    ws_streams: dict[str, GuestWsStream] = field(default_factory=dict)
    # Guest/HTTP → host frames. A dedicated pump task drains this so guest
    # handlers never await tunnel send_json directly (avoids TestClient nested
    # WebSocket deadlocks and keeps the tunnel receive loop responsive).
    to_host: asyncio.Queue[dict[str, Any] | None] = field(default_factory=asyncio.Queue)
    connected_at: float = field(default_factory=time.time)

    async def enqueue_to_host(self, payload: dict[str, Any]) -> None:
        await self.to_host.put(payload)


class RelayState:
    def __init__(
        self,
        host_tokens: set[str],
        *,
        allow_open_tunnel: bool = False,
        host_secrets: dict[str, str] | None = None,
    ) -> None:
        self.host_tokens = host_tokens
        self.host_secrets = dict(host_secrets or {})
        self.allow_open_tunnel = allow_open_tunnel
        self._lock = asyncio.Lock()
        self.tunnels: dict[str, TunnelSession] = {}
        # Live routing only (cleared on unregister).
        self.token_to_host: dict[str, str] = {}
        # Durable ownership across disconnect (cleared when owner omits token).
        self.token_bindings: dict[str, str] = {}

    def token_ok(self, token: str, *, host_id: str | None = None) -> bool:
        if not token:
            return False
        if not self.host_tokens and not self.host_secrets:
            return self.allow_open_tunnel
        from podcast_relay.share_claims import resolve_tunnel_secret

        if host_id:
            return resolve_tunnel_secret(
                token,
                shared_secrets=self.host_tokens,
                host_secrets=self.host_secrets,
                host_id=host_id,
            ) is not None or (
                self.allow_open_tunnel and not self.host_tokens and not self.host_secrets
            )
        # Pre-host_id hello check: accept any known secret.
        if any(len(token) == len(t) and secrets.compare_digest(token, t) for t in self.host_tokens):
            return True
        return any(
            len(token) == len(t) and secrets.compare_digest(token, t)
            for t in self.host_secrets.values()
        )

    def secret_for_session(self, session: TunnelSession) -> str | None:
        from podcast_relay.share_claims import resolve_tunnel_secret

        if self.allow_open_tunnel and not self.host_tokens and not self.host_secrets:
            # Dev open tunnel: sign/verify with the presented token (may be empty → skip claims).
            return session.host_token or "open-tunnel-dev"
        return resolve_tunnel_secret(
            session.host_token,
            shared_secrets=self.host_tokens,
            host_secrets=self.host_secrets,
            host_id=session.host_id,
        )

    async def register_tunnel(self, session: TunnelSession) -> None:
        async with self._lock:
            old = self.tunnels.get(session.host_id)
            if old is not None:
                for t in list(old.share_tokens):
                    if self.token_to_host.get(t) == session.host_id:
                        self.token_to_host.pop(t, None)
            self.tunnels[session.host_id] = session
            for t in session.share_tokens:
                self.token_to_host[t] = session.host_id

    async def unregister_tunnel(self, host_id: str) -> None:
        async with self._lock:
            session = self.tunnels.pop(host_id, None)
            if session is None:
                return
            for t in list(session.share_tokens):
                if self.token_to_host.get(t) == host_id:
                    self.token_to_host.pop(t, None)
            # Keep token_bindings so another host cannot steal after disconnect.
            for stream in list(session.ws_streams.values()):
                with contextlib.suppress(Exception):
                    stream.queue.put_nowait(None)
            session.ws_streams.clear()
            with contextlib.suppress(Exception):
                session.to_host.put_nowait(None)

    async def update_shares(
        self,
        host_id: str,
        shares: list[dict[str, Any]],
    ) -> None:
        from podcast_relay.share_claims import verify_share_claim

        async with self._lock:
            session = self.tunnels.get(host_id)
            if session is None:
                return
            secret = self.secret_for_session(session)
            open_dev = self.allow_open_tunnel and not self.host_tokens and not self.host_secrets
            # Clear live routing for this host's previous advertisement.
            for t in list(session.share_tokens):
                if self.token_to_host.get(t) == host_id:
                    self.token_to_host.pop(t, None)
            previous = set(session.share_tokens)
            session.share_tokens.clear()
            session.capabilities.clear()
            accepted: set[str] = set()
            for row in shares:
                if not isinstance(row, dict):
                    continue
                token = str(row.get("token") or "")
                if not token:
                    continue
                caps = [str(c) for c in (row.get("capabilities") or [])]
                claim = str(row.get("claim") or "")
                claim_host = str(row.get("host_id") or host_id)
                if claim_host != host_id:
                    continue
                if not open_dev and (
                    secret is None
                    or not verify_share_claim(
                        secret,
                        host_id=host_id,
                        token=token,
                        capabilities=caps,
                        claim=claim,
                    )
                ):
                    continue
                bound = self.token_bindings.get(token)
                if bound is not None and bound != host_id:
                    continue
                live = self.token_to_host.get(token)
                if live is not None and live != host_id:
                    continue
                session.share_tokens.add(token)
                session.capabilities[token] = caps
                self.token_to_host[token] = host_id
                self.token_bindings[token] = host_id
                accepted.add(token)
            # Owner omitted a previously advertised token → release binding.
            for t in previous - accepted:
                if self.token_bindings.get(t) == host_id:
                    self.token_bindings.pop(t, None)

    def tunnel_for_token(self, token: str) -> TunnelSession | None:
        host_id = self.token_to_host.get(token)
        if not host_id:
            return None
        return self.tunnels.get(host_id)


def _parse_host_tokens() -> tuple[set[str], dict[str, str]]:
    from podcast_relay.share_claims import parse_host_token_map

    raw = os.environ.get("PODCAST_RELAY_HOST_TOKENS", "").strip()
    if not raw:
        return set(), {}
    return parse_host_token_map(raw)


def _allow_open_tunnel() -> bool:
    raw = os.environ.get("PODCAST_RELAY_ALLOW_OPEN_TUNNEL", "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def create_relay_app() -> FastAPI:
    shared, by_host = _parse_host_tokens()
    state = RelayState(
        shared,
        allow_open_tunnel=_allow_open_tunnel(),
        host_secrets=by_host,
    )
    app = FastAPI(
        title="Podcast Relay",
        version=read_relay_version(),
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.relay = state

    @app.get("/healthz")
    def healthz() -> dict[str, Any]:
        return {
            "ok": True,
            "version": read_relay_version(),
            "git_sha": read_relay_git_sha(),
            "tunnels": len(state.tunnels),
            "shares": len(state.token_to_host),
        }

    @app.get("/llms.txt")
    def llms_txt() -> PlainTextResponse:
        """Machine-readable summary for agentic browsing (domain root)."""
        body = (
            "# Podcast MCP review shares\n\n"
            "This origin hosts opaque review share links for Podcast MCP.\n\n"
            "## Shares\n\n"
            "- Guest review URLs look like `/r/{token}` "
            "(token capability set: play/view/comment/…).\n"
            "- Guest recording URLs look like `/rec/{token}` "
            "(studio lobby; not a review mix).\n"
            "- Do not invent filesystem paths; guests never receive host paths.\n"
            "- When the project host tunnel is offline, shares return 503.\n\n"
            "## Docs\n\n"
            "- https://docs.sharecut.studio/\n"
            "- https://docs.sharecut.studio/#/quickstart\n"
            "- https://docs.sharecut.studio/schemas/document-commands.schema.json\n"
            "- https://docs.sharecut.studio/llms.txt\n"
            "- https://github.com/calebn/sharecut-studio\n"
        )
        return PlainTextResponse(body, media_type="text/plain; charset=utf-8")

    @app.websocket("/tunnel")
    async def tunnel_ws(websocket: WebSocket) -> None:
        await websocket.accept()
        host_id: str | None = None
        session: TunnelSession | None = None
        try:
            first = await websocket.receive_json()
            if first.get("type") != "hello":
                await websocket.send_json(msg("error", detail="expected hello"))
                await websocket.close(code=4400)
                return
            host_token = str(first.get("host_token") or "")
            if not state.token_ok(host_token):
                await websocket.send_json(msg("error", detail="invalid host_token"))
                await websocket.close(code=4403)
                return
            reg = check_register(host_token)
            if not reg.allowed:
                await websocket.send_json(
                    msg(
                        "error",
                        detail="rate limit exceeded",
                        bucket=reg.bucket,
                        retry_after_sec=reg.retry_after_sec,
                    )
                )
                await websocket.close(code=4429)
                return
            host_id = str(first.get("host_id") or new_id())
            if not state.token_ok(host_token, host_id=host_id):
                await websocket.send_json(msg("error", detail="invalid host_token for host_id"))
                await websocket.close(code=4403)
                return
            session = TunnelSession(
                host_id=host_id,
                websocket=websocket,
                host_token=host_token,
            )
            await state.register_tunnel(session)
            await websocket.send_json(msg("hello", host_id=host_id, ok=True))

            async def _pump_to_host() -> None:
                assert session is not None
                while True:
                    payload = await session.to_host.get()
                    if payload is None:
                        break
                    await websocket.send_json(payload)

            host_pump = asyncio.create_task(_pump_to_host())
            try:
                while True:
                    data = await websocket.receive_json()
                    mtype = data.get("type")
                    if mtype == "register":
                        reg2 = check_register(host_token)
                        if not reg2.allowed:
                            await websocket.send_json(
                                msg(
                                    "error",
                                    detail="rate limit exceeded",
                                    bucket=reg2.bucket,
                                    retry_after_sec=reg2.retry_after_sec,
                                )
                            )
                            continue
                        shares = data.get("shares") or []
                        if not isinstance(shares, list):
                            shares = []
                        await state.update_shares(host_id, shares)
                        await websocket.send_json(
                            msg(
                                "register",
                                ok=True,
                                share_count=len(session.share_tokens),
                            )
                        )
                    elif mtype == "http_response":
                        req_id = str(data.get("id") or "")
                        pending = session.pending.get(req_id)
                        if pending is not None:
                            await _ingest_http_response(pending, data)
                    elif mtype == "ws_data":
                        stream = session.ws_streams.get(str(data.get("id") or ""))
                        if stream is not None:
                            with contextlib.suppress(Exception):
                                stream.queue.put_nowait(str(data.get("text") or ""))
                    elif mtype == "ws_close":
                        stream = session.ws_streams.pop(str(data.get("id") or ""), None)
                        if stream is not None:
                            with contextlib.suppress(Exception):
                                stream.queue.put_nowait(None)
                    elif mtype == "ping":
                        await websocket.send_json(msg("pong"))
                    elif mtype == "pong":
                        pass
                    else:
                        await websocket.send_json(msg("error", detail=f"unknown type {mtype!r}"))
            finally:
                with contextlib.suppress(Exception):
                    session.to_host.put_nowait(None)
                if not host_pump.done():
                    host_pump.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await host_pump
        except WebSocketDisconnect:
            pass
        finally:
            if host_id:
                await state.unregister_tunnel(host_id)

    async def _proxy(
        request: Request,
        token: str,
        path_suffix: str,
    ) -> Response:
        if not proxy_path_is_safe(path_suffix):
            return JSONResponse(
                {"detail": "unsafe proxy path"},
                status_code=400,
            )

        session = state.tunnel_for_token(token)
        if session is None:
            # SPA fetches under /api/review and /mcp - return JSON so the client
            # does not render the offline HTML document as plain-text error UI.
            if (
                path_suffix.startswith(("api/review", "api/rec", "mcp"))
                or path_suffix.rstrip("/") == "r/mcp"
            ):
                return JSONResponse(
                    {
                        "detail": "host offline",
                        "message": (
                            "This share link is valid, but the project host is "
                            "not connected. Ask them to run podcast tunnel."
                        ),
                    },
                    status_code=503,
                )
            if path_suffix.startswith("rec/"):
                return HTMLResponse(_OFFLINE_RECORD_HTML, status_code=503)
            return HTMLResponse(_OFFLINE_HTML, status_code=503)

        caps = session.capabilities.get(token) or []
        # Path-based capability gates (best-effort; host enforces too)
        mcp_path = path_suffix.startswith("mcp") or path_suffix.rstrip("/") == "r/mcp"
        if mcp_path and "mcp" not in caps:
            return JSONResponse({"detail": "share does not allow mcp"}, status_code=403)

        client_ip = request.client.host if request.client else None
        rpm = check_proxy_rpm(token=token, client_ip=client_ip, path_suffix=path_suffix)
        if not rpm.allowed:
            return JSONResponse(
                rate_limit_detail(rpm),
                status_code=429,
                headers={"Retry-After": rpm.retry_after_header},
            )

        # Hold concurrency until the proxied response finishes streaming.
        gates: list[tuple[Any, str]] = []

        def _release_gates() -> None:
            for gate, key in reversed(gates):
                gate.exit(key)

        if relay_rate_limit_enabled():
            lim = get_relay_limiters()
            if is_audio_path(path_suffix):
                d = lim.audio_concurrent.try_enter(token)
                if not d.allowed:
                    return JSONResponse(
                        rate_limit_detail(d),
                        status_code=429,
                        headers={"Retry-After": d.retry_after_header},
                    )
                gates.append((lim.audio_concurrent, token))
            d = lim.token_concurrent.try_enter(token)
            if not d.allowed:
                _release_gates()
                return JSONResponse(
                    rate_limit_detail(d),
                    status_code=429,
                    headers={"Retry-After": d.retry_after_header},
                )
            gates.append((lim.token_concurrent, token))
            d = lim.host_concurrent.try_enter(session.host_id)
            if not d.allowed:
                _release_gates()
                return JSONResponse(
                    rate_limit_detail(d),
                    status_code=429,
                    headers={"Retry-After": d.retry_after_header},
                )
            gates.append((lim.host_concurrent, session.host_id))

        limit = relay_max_body_bytes()
        if is_record_upload_path(path_suffix):
            limit = max(limit, record_upload_max_part_bytes())
        try:
            body = await read_body_capped(request, limit)
        except BodyTooLarge:
            _release_gates()
            return payload_too_large_response(limit)

        req_id = new_id()
        pending = PendingHttp()
        session.pending[req_id] = pending
        try:
            await session.websocket.send_json(
                msg(
                    "http",
                    id=req_id,
                    method=request.method,
                    path=path_suffix,
                    query=str(request.url.query or ""),
                    headers={
                        k: v
                        for k, v in request.headers.items()
                        if k.lower() not in ("host", "content-length", "connection")
                    },
                    body_b64=base64.b64encode(body).decode("ascii") if body else "",
                    share_token=token,
                )
            )
            try:
                await asyncio.wait_for(pending.headers_ready.wait(), timeout=300.0)
            except TimeoutError:
                session.pending.pop(req_id, None)
                _release_gates()
                return JSONResponse({"detail": "host timed out"}, status_code=504)

            out_headers = _response_headers(pending.headers)
            media = pending.headers.get("content-type") or pending.headers.get("Content-Type")

            async def _stream() -> Any:
                try:
                    while True:
                        chunk = await pending.queue.get()
                        if chunk is None:
                            break
                        yield chunk
                finally:
                    session.pending.pop(req_id, None)
                    _release_gates()

            return StreamingResponse(
                _stream(),
                status_code=pending.status,
                headers=out_headers,
                media_type=media,
            )
        except Exception:
            session.pending.pop(req_id, None)
            _release_gates()
            raise

    @app.api_route(
        "/r/{token}",
        methods=["GET", "HEAD"],
    )
    async def share_root(token: str, request: Request) -> Response:
        return await _proxy(request, token, "r/")

    @app.api_route(
        "/r/{token}/{path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def share_path(token: str, path: str, request: Request) -> Response:
        return await _proxy(request, token, f"r/{path}")

    @app.api_route(
        "/rec/{token}",
        methods=["GET", "HEAD"],
    )
    async def record_root(token: str, request: Request) -> Response:
        return await _proxy(request, token, "rec/")

    @app.api_route(
        "/rec/{token}/{path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def record_path(token: str, path: str, request: Request) -> Response:
        return await _proxy(request, token, f"rec/{path}")

    @app.api_route(
        "/api/review/{token}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def api_review_root(token: str, request: Request) -> Response:
        return await _proxy(request, token, "api/review/")

    @app.api_route(
        "/api/review/{token}/{path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def api_review_path(token: str, path: str, request: Request) -> Response:
        return await _proxy(request, token, f"api/review/{path}")

    @app.api_route(
        "/api/rec/{token}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def api_rec_root(token: str, request: Request) -> Response:
        return await _proxy(request, token, "api/rec/")

    @app.api_route(
        "/api/rec/{token}/{path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def api_rec_path(token: str, path: str, request: Request) -> Response:
        return await _proxy(request, token, f"api/rec/{path}")

    @app.api_route(
        "/mcp/{token}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def mcp_root(token: str, request: Request) -> Response:
        return await _proxy(request, token, "mcp/")

    @app.api_route(
        "/mcp/{token}/{path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    )
    async def mcp_path(token: str, path: str, request: Request) -> Response:
        return await _proxy(request, token, f"mcp/{path}")

    async def _bridge_guest_ws(
        websocket: WebSocket,
        token: str,
        *,
        path: str,
        required_cap: str | None,
    ) -> None:
        """Bridge a guest WS through the host tunnel (text frames only)."""

        async def _reject(code: int, reason: str) -> None:
            await websocket.accept()
            await websocket.close(code=code, reason=reason[:120])

        session = state.tunnel_for_token(token)
        if session is None:
            await _reject(1013, "host offline")
            return
        caps = session.capabilities.get(token) or []
        if required_cap and caps and required_cap not in caps:
            await _reject(4403, f"share does not allow {required_cap}")
            return

        gate_held = False
        if relay_rate_limit_enabled():
            lim = get_relay_limiters()
            decision = lim.ws_concurrent.try_enter(token)
            if not decision.allowed:
                await _reject(4429, "guest ws concurrency limit")
                return
            gate_held = True

        await websocket.accept()
        stream_id = new_id()
        stream = GuestWsStream()
        session.ws_streams[stream_id] = stream
        try:
            await session.enqueue_to_host(
                msg(
                    "ws_open",
                    id=stream_id,
                    path=path,
                    share_token=token,
                )
            )

            async def _pump_to_guest() -> None:
                while True:
                    text = await stream.queue.get()
                    if text is None:
                        break
                    await websocket.send_text(text)

            pump = asyncio.create_task(_pump_to_guest())
            recv = asyncio.create_task(websocket.receive_text())
            try:
                while True:
                    done, _pending = await asyncio.wait(
                        {pump, recv}, return_when=asyncio.FIRST_COMPLETED
                    )
                    if pump in done:
                        break
                    if recv in done:
                        try:
                            text = recv.result()
                        except WebSocketDisconnect:
                            break
                        except Exception:
                            break
                        if len(text) > GUEST_FRAME_MAX_BYTES:
                            await websocket.close(code=4400, reason="frame too large")
                            break
                        if relay_rate_limit_enabled():
                            lim = get_relay_limiters()
                            bucket = lim.ws_presence if is_presence_ws_text(text) else lim.ws_msg
                            msg_dec = bucket.allow(token)
                            if not msg_dec.allowed:
                                recv = asyncio.create_task(websocket.receive_text())
                                continue
                        await session.enqueue_to_host(msg("ws_data", id=stream_id, text=text))
                        recv = asyncio.create_task(websocket.receive_text())
            finally:
                if not pump.done():
                    pump.cancel()
                if not recv.done():
                    recv.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await pump
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await recv
        finally:
            session.ws_streams.pop(stream_id, None)
            with contextlib.suppress(Exception):
                await session.enqueue_to_host(msg("ws_close", id=stream_id, code=1000, reason=""))
            with contextlib.suppress(Exception):
                await websocket.close(code=1000)
            if gate_held:
                get_relay_limiters().ws_concurrent.exit(token)

    @app.websocket("/api/review/{token}/daw/ws")
    async def guest_daw_ws(websocket: WebSocket, token: str) -> None:
        await _bridge_guest_ws(websocket, token, path="api/review/daw/ws", required_cap="view")

    @app.websocket("/api/review/{token}/progress/ws")
    async def guest_progress_ws(websocket: WebSocket, token: str) -> None:
        await _bridge_guest_ws(websocket, token, path="api/review/progress/ws", required_cap=None)

    @app.websocket("/api/rec/{token}/ws")
    async def record_guest_ws(websocket: WebSocket, token: str) -> None:
        await _bridge_guest_ws(websocket, token, path="api/rec/ws", required_cap="monitor")

    return app


def main() -> None:
    import sys

    import uvicorn

    shared, by_host = _parse_host_tokens()
    if not shared and not by_host and not _allow_open_tunnel():
        print(
            "FATAL: PODCAST_RELAY_HOST_TOKENS is empty. "
            "Set one or more host tokens, or set "
            "PODCAST_RELAY_ALLOW_OPEN_TUNNEL=1 for local/dev only.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    # Bind-all is intentional for the public relay edge; override via env for local.
    default_host = "0.0.0.0"  # nosec B104
    host = os.environ.get("PODCAST_RELAY_HOST", default_host)
    port = int(os.environ.get("PODCAST_RELAY_PORT", "8081"))
    ws_max_size = relay_ws_max_size()
    uvicorn.run(
        "podcast_relay.app:create_relay_app",
        factory=True,
        host=host,
        port=port,
        log_level="info",
        ws_max_size=ws_max_size,
    )


if __name__ == "__main__":
    main()
