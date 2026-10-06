"""TunnelClient - outbound WebSocket tunnel connecting the host to the relay."""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import json
import logging
import signal
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from podcast_mcp.edits.review_shares import list_usable_shares
from podcast_mcp.models import load_project
from podcast_mcp.runtime_config import RelayConfig, load_relay_config
from podcast_mcp.services.collaboration.tunnel_failure import (
    FailureKind,
    TunnelError,
    TunnelFailure,
    classify_failure,
    relay_rejection,
)
from podcast_mcp.services.collaboration.tunnel_status import (
    HEARTBEAT_INTERVAL_SEC,
    LineListener,
    StatusFileListener,
    StatusListener,
    TunnelPhase,
    TunnelStatusTracker,
    heartbeat_loop,
    tunnel_status_path,
)
from podcast_mcp.util.body_limits import relay_ws_max_size
from podcast_mcp.util.proxy_paths import (
    RELAYED_REQUEST_HEADER,
    UnsafeProxyPath,
    assert_allowed_local_gui_path,
    assert_safe_proxy_path,
)
from podcast_mcp.util.ws_delivery import (
    WS_SEND_TIMEOUT_S,
    SerializedWsWriter,
    TextWsStream,
    ws_close_details,
)
from podcast_relay.protocol import PROTOCOL_VERSION, msg

log = logging.getLogger(__name__)

# Review mixes can be hundreds of MB; send in chunks so WS keepalive stays alive.
# Frame size aligns with relay ``PODCAST_RELAY_WS_MAX_SIZE`` (default 16 MiB).
_PROXY_TIMEOUT = 300.0
_RESPONSE_CHUNK = 512 * 1024

# Map (relay path prefix) → (local path template with {token} placeholder).
# Longer prefixes first: share HTML is rewritten so browsers request
# /r/{token}/assets/... which must hit the GUI's /assets mount.
_PATH_PREFIXES: list[tuple[str, str]] = [
    ("r/assets/", "/assets/"),
    ("r/favicon.svg", "/favicon.svg"),
    ("r/favicon.ico", "/favicon.ico"),
    ("r/", "/r/{token}/"),
    ("rec/assets/", "/assets/"),
    ("rec/favicon.svg", "/favicon.svg"),
    ("rec/favicon.ico", "/favicon.ico"),
    ("rec/", "/rec/{token}/"),
    ("api/review/", "/api/review/{token}/"),
    ("api/rec/", "/api/rec/{token}/"),
    ("mcp/", "/mcp/{token}/"),
]

_SHARE_HTML_ROOT_PATHS = ("/assets/", "/favicon.svg", "/favicon.ico")


def _rewrite_share_html(content: bytes, share_token: str, *, prefix: str = "r") -> bytes:
    """Prefix root-absolute static URLs so they stay under /{prefix}/{token}/ on the relay.

    Also injects ``<base href="/{prefix}/{token}/">`` so Vite's relative ``./assets/…``
    lazy chunks resolve under the share path when the document URL has no
    trailing slash (``/{prefix}/{token}``).
    """
    if not share_token or not content:
        return content
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return content
    html_prefix = f"/{prefix}/{share_token}"
    base_tag = f'<base href="{html_prefix}/" />'
    if "<base " not in text.lower():
        lowered = text.lower()
        head_idx = lowered.find("<head")
        if head_idx != -1:
            gt = text.find(">", head_idx)
            if gt != -1:
                text = text[: gt + 1] + base_tag + text[gt + 1 :]
    for root in _SHARE_HTML_ROOT_PATHS:
        rewritten = f"{html_prefix}{root}"
        text = text.replace(f'"{root}', f'"{rewritten}')
        text = text.replace(f"'{root}", f"'{rewritten}")
        # Vite ``base: './'`` emits ``./assets/…`` / ``./favicon.svg``
        dotted = f".{root}"
        text = text.replace(f'"{dotted}', f'"{rewritten}')
        text = text.replace(f"'{dotted}", f"'{rewritten}")
    return text.encode("utf-8")


_HOP_BY_HOP = frozenset(
    {
        "host",
        "content-length",
        "connection",
        "transfer-encoding",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "upgrade",
        # Forwarding headers make Starlette/uvicorn emit https:// redirects
        # to the local GUI, which has no TLS.
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-forwarded-port",
        "x-forwarded-server",
        "x-real-ip",
        # guest-supplied copies are dropped; _proxy_http stamps its own
        RELAYED_REQUEST_HEADER,
    }
)


def _map_local_path(path_suffix: str, share_token: str) -> str:
    """Map a relay ``path_suffix`` + ``share_token`` to a local GUI URL path.

    Raises ``UnsafeProxyPath`` for traversal attempts or unknown prefixes.
    """
    assert_safe_proxy_path(path_suffix)
    # Claude / mistaken share+/mcp URL: rewrite to canonical guest MCP bridge
    # (no HTTP redirect - same-host path rewrite).
    if path_suffix.rstrip("/") == "r/mcp":
        return assert_allowed_local_gui_path(f"/mcp/{share_token}/mcp", share_token)
    mapped: str | None = None
    for prefix, local_tpl in _PATH_PREFIXES:
        if path_suffix.startswith(prefix):
            rest = path_suffix[len(prefix) :]
            # Share document root must match GUI ``/r/{token}`` / ``/rec/{token}``
            # (no trailing slash) or Starlette emits a 307 Location to localhost.
            if prefix in {"r/", "rec/"} and rest == "":
                mapped = f"/{prefix.rstrip('/')}/{share_token}"
            else:
                local_base = local_tpl.replace("{token}", share_token)
                mapped = local_base + rest
            break
    if mapped is None:
        raise UnsafeProxyPath(f"unknown proxy prefix: {path_suffix!r}")
    return assert_allowed_local_gui_path(mapped, share_token)


def _relay_host(relay_url: str) -> str:
    """``host[:port]`` of the relay URL; user info and path never reach a status line."""
    parsed = urlparse(relay_url)
    host = parsed.hostname or "unknown"
    return f"{host}:{parsed.port}" if parsed.port else host


class TunnelClient:
    """Outbound WebSocket tunnel connecting the host to the relay server."""

    def __init__(
        self,
        cfg: RelayConfig,
        project_path: Path | None = None,
        *,
        listeners: list[StatusListener] | None = None,
        sleep: Callable[[float], Awaitable[None]] | None = None,
    ) -> None:
        self._cfg = cfg
        self._project_path = project_path
        self._sleep = sleep
        self._tracker = TunnelStatusTracker(
            relay_host=_relay_host(cfg.relay_url),
            public_base_url=cfg.public_base_url,
            listeners=listeners if listeners is not None else [LineListener()],
            secrets=[cfg.host_token],
        )

    @property
    def tracker(self) -> TunnelStatusTracker:
        return self._tracker

    def _build_shares(self) -> list[dict[str, Any]]:
        if self._project_path is None:
            return []
        try:
            from podcast_relay.share_claims import attach_share_claims

            proj = load_project(self._project_path)
            rows = [
                {
                    "token": row["token"],
                    "capabilities": list(row.get("capabilities") or []),
                }
                for row in list_usable_shares(proj)
                if row.get("token")
            ]
            self._tracker.add_secrets([row["token"] for row in rows])
            secret = self._cfg.host_token
            if not secret:
                return rows
            return attach_share_claims(rows, host_id=self._cfg.host_id, secret=secret)
        except Exception:
            log.exception("Could not load shares from project")
            return []

    async def _proxy_http(
        self,
        http_client: Any,
        request_data: dict[str, Any],
        *,
        send: Any,
    ) -> None:
        """Fetch from local GUI and send one or more ``http_response`` frames."""

        req_id = str(request_data.get("id") or "")
        method = str(request_data.get("method") or "GET")
        path_suffix = str(request_data.get("path") or "")
        query = str(request_data.get("query") or "")
        share_token = str(request_data.get("share_token") or "")
        try:
            raw_headers = request_data.get("headers", {})
            if not isinstance(raw_headers, dict) or any(
                not isinstance(k, str) or not isinstance(v, str) for k, v in raw_headers.items()
            ):
                raise ValueError("invalid relay request headers")
            headers = {k: v for k, v in raw_headers.items() if k.lower() not in _HOP_BY_HOP}
            headers[RELAYED_REQUEST_HEADER] = "1"
            body_b64 = request_data.get("body_b64", "")
            if not isinstance(body_b64, str):
                raise ValueError("invalid relay request body")
            body = base64.b64decode(body_b64, validate=True) if body_b64 else None
        except (ValueError, binascii.Error) as exc:
            log.warning("Rejected malformed relay HTTP request: %s", self._tracker.redact(str(exc)))
            await send(
                msg(
                    "http_response",
                    id=req_id,
                    status=400,
                    headers={"content-type": "application/json"},
                    body_b64=base64.b64encode(b'{"detail":"invalid proxy request"}').decode(
                        "ascii"
                    ),
                    eof=True,
                )
            )
            return

        try:
            local_path = _map_local_path(path_suffix, share_token)
        except UnsafeProxyPath as exc:
            log.warning(
                "Rejected unsafe proxy path %r: %s",
                self._tracker.redact(path_suffix),
                self._tracker.redact(str(exc)),
            )
            await send(
                msg(
                    "http_response",
                    id=req_id,
                    status=400,
                    headers={"content-type": "application/json"},
                    body_b64=base64.b64encode(b'{"detail":"unsafe proxy path"}').decode("ascii"),
                    eof=True,
                )
            )
            return

        url = self._cfg.local_gui_url.rstrip("/") + local_path
        if query:
            url = url + "?" + query

        try:
            # Do not follow redirects: the share /audio route may 302 to object storage so the
            # browser fetches media outside the WebSocket tunnel.
            async with http_client.stream(
                method,
                url,
                headers=headers,
                content=body,
                follow_redirects=False,
                timeout=_PROXY_TIMEOUT,
            ) as resp:
                resp_headers = dict(resp.headers)
                ctype = (resp_headers.get("content-type") or "").lower()
                if share_token and "text/html" in ctype:
                    # aread() decompresses; drop encoding and recompute length.
                    content = _rewrite_share_html(
                        await resp.aread(),
                        share_token,
                        prefix="rec" if path_suffix.startswith("rec/") else "r",
                    )
                    html_headers = {
                        k: v
                        for k, v in resp_headers.items()
                        if k.lower() not in ("content-length", "content-encoding")
                    }
                    html_headers["content-length"] = str(len(content))
                    await send(
                        msg(
                            "http_response",
                            id=req_id,
                            status=resp.status_code,
                            headers=html_headers,
                            body_b64=base64.b64encode(content).decode("ascii") if content else "",
                            eof=True,
                        )
                    )
                    return

                # httpx aiter_bytes() decompresses while leaving the compressed
                # Content-Length - that mismatch resets HTTP/2 at Caddy. Drop
                # encoding/length and stream the decoded body (chunked at edge).
                stream_headers = {
                    k: v
                    for k, v in resp_headers.items()
                    if k.lower() not in ("content-encoding", "content-length")
                }
                first = True
                stream_iter = (
                    resp.aiter_bytes()
                    if "text/event-stream" in ctype
                    else resp.aiter_bytes(_RESPONSE_CHUNK)
                )
                async for piece in stream_iter:
                    payload: dict[str, Any] = {
                        "type": "http_response",
                        "id": req_id,
                        "body_b64": base64.b64encode(piece).decode("ascii"),
                        "eof": False,
                    }
                    if first:
                        payload["status"] = resp.status_code
                        payload["headers"] = stream_headers
                        first = False
                    await send(payload)
                    await asyncio.sleep(0)

                final: dict[str, Any] = {
                    "type": "http_response",
                    "id": req_id,
                    "body_b64": "",
                    "eof": True,
                }
                if first:
                    final["status"] = resp.status_code
                    final["headers"] = resp_headers
                await send(final)
        except Exception as exc:
            log.warning(
                "Proxy error for %s %s: %s",
                method,
                self._tracker.redact(url),
                self._tracker.redact(str(exc)),
            )
            await send(
                msg(
                    "http_response",
                    id=req_id,
                    status=502,
                    headers={},
                    body_b64="",
                    eof=True,
                )
            )

    async def _proxy_ws(
        self,
        open_data: dict[str, Any],
        *,
        send: Any,
        streams: dict[str, TextWsStream],
    ) -> None:
        """Dial the local GUI guest WS and bridge text frames both ways."""
        import websockets  # type: ignore[import-untyped]
        from websockets.exceptions import ConnectionClosed

        stream_id = str(open_data.get("id") or "")
        path_suffix = str(open_data.get("path") or "")
        share_token = str(open_data.get("share_token") or "")
        if not stream_id:
            return

        try:
            local_path = _map_local_path(path_suffix, share_token)
        except UnsafeProxyPath as exc:
            log.warning(
                "Rejected unsafe guest WS path %r: %s",
                self._tracker.redact(path_suffix),
                self._tracker.redact(str(exc)),
            )
            await send(msg("ws_close", id=stream_id, code=4400, reason="unsafe path"))
            return

        base = self._cfg.local_gui_url.rstrip("/")
        if base.startswith("https://"):
            ws_base = "wss://" + base[len("https://") :]
        elif base.startswith("http://"):
            ws_base = "ws://" + base[len("http://") :]
        else:
            ws_base = base.replace("http", "ws", 1)
        url = ws_base + local_path

        stream = TextWsStream()
        queue = stream.queue
        streams[stream_id] = stream
        close_code = 1000
        close_reason = ""
        try:
            async with websockets.connect(
                url,
                max_size=relay_ws_max_size(),
                open_timeout=30.0,
                ping_interval=20.0,
                ping_timeout=120.0,
                additional_headers={RELAYED_REQUEST_HEADER: "1"},
            ) as local_ws:

                async def _to_relay() -> None:
                    try:
                        async for frame in local_ws:
                            text = (
                                frame
                                if isinstance(frame, str)
                                else frame.decode("utf-8", errors="replace")
                            )
                            await send(msg("ws_data", id=stream_id, text=text))
                    except ConnectionClosed:
                        pass
                    finally:
                        queue.close()

                async def _to_local() -> None:
                    while True:
                        text = await queue.get()
                        if text is None:
                            break
                        async with asyncio.timeout(WS_SEND_TIMEOUT_S):
                            await local_ws.send(text)

                up = asyncio.create_task(_to_relay())
                down = asyncio.create_task(_to_local())
                try:
                    done, _ = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
                    if stream.close_code != 1000:
                        close_code = stream.close_code
                        close_reason = stream.close_reason
                    elif up in done:
                        close_code = int(getattr(local_ws, "close_code", None) or 1000)
                        close_reason = str(getattr(local_ws, "close_reason", None) or "")
                    else:
                        try:
                            down.result()
                        except TimeoutError:
                            close_code = 1013
                            close_reason = "slow consumer"
                finally:
                    for task in (up, down):
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(up, down, return_exceptions=True)
                    if close_code != 1000 and up not in done:
                        async with asyncio.timeout(WS_SEND_TIMEOUT_S):
                            await local_ws.close(code=close_code, reason=close_reason)
        except TimeoutError:
            close_code = 1013
            close_reason = "slow consumer"
        except Exception as exc:
            close_code = 1011
            close_reason = "proxy failed"
            log.warning(
                "Guest WS proxy error for %s: %s",
                self._tracker.redact(url),
                self._tracker.redact(str(exc)),
            )
        finally:
            streams.pop(stream_id, None)
            with contextlib.suppress(Exception):  # pragma: no cover
                await send(
                    msg("ws_close", id=stream_id, code=close_code, reason=close_reason[:120])
                )

    async def _run_once(self) -> None:
        """Single connect → hello → register → proxy until disconnect."""
        import httpx
        import websockets  # type: ignore[import-untyped]

        cfg = self._cfg
        shares = self._build_shares()

        async with websockets.connect(
            cfg.relay_url,
            max_size=relay_ws_max_size(),
            open_timeout=30.0,
            ping_interval=20.0,
            ping_timeout=120.0,
        ) as ws:

            async def write(payload: dict[str, Any]) -> None:
                await ws.send(json.dumps(payload))

            async def close(code: int, reason: str) -> None:
                await ws.close(code=code, reason=reason)

            writer = SerializedWsWriter(write, close)
            send = writer.send

            share_count = await self._register(ws, send, shares)
            self._tracker.connected(share_count=share_count)
            async with httpx.AsyncClient() as http_client:
                await self._serve_messages(ws, http_client, send)

    @staticmethod
    def _expect_ack(ack: dict[str, Any], expected: str) -> dict[str, Any]:
        """Return ``ack`` when it is the ok ``expected`` frame, else raise the classified failure."""
        if ack.get("type") == expected and ack.get("ok"):
            return ack
        if ack.get("type") == "error":
            retry_after = ack.get("retry_after_sec")
            raise TunnelError(
                relay_rejection(
                    str(ack.get("detail") or ""),
                    retry_after_sec=float(retry_after)
                    if isinstance(retry_after, int | float)
                    else 0.0,
                )
            )
        raise TunnelError(
            TunnelFailure(FailureKind.ERROR, f"Relay rejected {expected}: unexpected reply")
        )

    async def _register(self, ws: Any, send: Any, shares: list[dict[str, Any]]) -> int:
        """Hello, then register ``shares``. Returns how many shares the relay accepted."""
        cfg = self._cfg
        await send(
            msg(
                "hello",
                host_token=cfg.host_token,
                host_id=cfg.host_id,
                protocol_version=PROTOCOL_VERSION,
            )
        )
        self._expect_ack(json.loads(await ws.recv()), "hello")
        await send(msg("register", shares=shares))
        reg_ack = self._expect_ack(json.loads(await ws.recv()), "register")
        accepted = reg_ack.get("share_count")
        return accepted if isinstance(accepted, int) else len(shares)

    async def _serve_messages(self, ws: Any, http_client: Any, send: Any) -> None:
        tasks: set[asyncio.Task[None]] = set()
        ws_streams: dict[str, TextWsStream] = {}
        try:
            while True:
                raw = json.loads(await ws.recv())
                mtype = raw.get("type")
                task: asyncio.Task[None] | None = None
                if mtype == "http":
                    task = asyncio.create_task(self._proxy_http(http_client, raw, send=send))
                elif mtype == "ws_open":
                    task = asyncio.create_task(self._proxy_ws(raw, send=send, streams=ws_streams))
                elif mtype in ("ws_data", "ws_close"):
                    stream_id = str(raw.get("id") or "")
                    stream = (
                        ws_streams.pop(stream_id, None)
                        if mtype == "ws_close"
                        else ws_streams.get(stream_id)
                    )
                    if stream is not None:
                        if mtype == "ws_close":
                            stream.close(*ws_close_details(raw.get("code"), raw.get("reason")))
                        else:
                            try:
                                stream.queue.put_nowait(str(raw.get("text") or ""))
                            except asyncio.QueueFull:
                                stream.close(1013, "host backlog full", discard=True)
                elif mtype == "ping":
                    log.debug("Relay ping answered")
                    await send(msg("pong"))
                elif mtype == "error":
                    log.error("Relay error: %s", self._tracker.redact(str(raw.get("detail"))))
                else:
                    log.debug("Unhandled relay message type: %s", mtype)
                if task is not None:
                    tasks.add(task)
                    task.add_done_callback(tasks.discard)
        finally:
            for stream in ws_streams.values():
                stream.close(1013, "tunnel disconnected", discard=True)
            ws_streams.clear()
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    async def run(
        self,
        *,
        max_attempts: int | None = None,
        initial_delay_sec: float = 1.0,
        max_delay_sec: float = 60.0,
    ) -> None:
        """Connect to the relay; reconnect with backoff until cancelled or a fatal failure.

        ``max_attempts`` limits consecutive failed tries (None = unlimited); a session
        that reached Connected resets the count and the backoff. Auth and config
        failures raise ``TunnelError`` at once. Cancellation propagates without
        reconnecting. Every exit but a failure leaves the status Stopped; a failure
        stays Failed so the host still sees why.
        """
        heartbeat = asyncio.create_task(heartbeat_loop(self._tracker, HEARTBEAT_INTERVAL_SEC))
        try:
            await self._reconnect_loop(max_attempts, initial_delay_sec, max_delay_sec)
        finally:
            heartbeat.cancel()
            await asyncio.gather(heartbeat, return_exceptions=True)
            if self._tracker.status.phase is not TunnelPhase.FAILED:
                self._tracker.stopped()

    async def _reconnect_loop(
        self, max_attempts: int | None, initial_delay_sec: float, max_delay_sec: float
    ) -> None:
        import secrets

        tracker = self._tracker
        rng = secrets.SystemRandom()
        failures = 0
        delay = initial_delay_sec
        tracker.connecting()
        while True:
            error: Exception | None = None
            try:
                await self._run_once()
                failure = TunnelFailure(FailureKind.RELAY_CLOSED, "relay ended the session")
            except (asyncio.CancelledError, ImportError):
                raise
            except Exception as exc:
                error = exc
                failure = classify_failure(exc)
            if tracker.status.phase is TunnelPhase.CONNECTED:
                failures = 0
                delay = initial_delay_sec
            failures += 1
            if failure.fatal:
                tracker.failed(failure)
                if isinstance(error, TunnelError):
                    raise error
                raise TunnelError(failure) from error
            tracker.disconnected(failure)
            if max_attempts is not None and failures >= max_attempts:
                tracker.failed(failure, gave_up_after=failures)
                if error is not None:
                    raise error
                return
            wait = max(delay, failure.retry_after_sec)
            wait += rng.uniform(0, min(1.0, wait * 0.25))
            tracker.reconnecting(attempt=failures, delay_sec=wait)
            await (self._sleep or asyncio.sleep)(wait)
            delay = min(max_delay_sec, delay * 2.0)


async def _run_until_signalled(client: TunnelClient) -> None:
    """Run ``client`` until SIGINT or SIGTERM, then return once it wrote its final status.

    The signal cancels the run, so the status file says Stopped before the process
    exits. Where the loop cannot take signal handlers (Windows, a non-main thread) the
    default behavior stays and a killed process is told apart by its recorded pid.
    """
    loop = asyncio.get_running_loop()
    running = asyncio.ensure_future(client.run())
    handled: list[signal.Signals] = []
    for stop in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(stop, running.cancel)
        except (NotImplementedError, RuntimeError):
            continue
        handled.append(stop)
    try:
        await running
    except asyncio.CancelledError:
        pass
    finally:
        for stop in handled:
            loop.remove_signal_handler(stop)


def run_tunnel_sync(
    project_path: Path | None = None,
    *,
    relay_url: str | None = None,
    host_token: str | None = None,
    public_base_url: str | None = None,
    local_gui_url: str | None = None,
    config_path: Path | None = None,
    emit: Callable[[str], None] | None = None,
) -> None:
    """Block the calling thread running the tunnel client event loop.

    ``emit`` receives one line per connection state change (default: ``log.info``).
    The live status snapshot the GUI reads is written to ``tunnel_status_path(cfg)``
    under the machine cache, whatever ``config_path`` is. SIGINT and SIGTERM stop the
    tunnel cleanly: the snapshot ends Stopped and this function returns.
    Raises ``TunnelError`` on an auth or config failure that retrying cannot fix.
    """
    cfg = load_relay_config(
        config_path,
        relay_url=relay_url,
        host_token=host_token,
        public_base_url=public_base_url,
        local_gui_url=local_gui_url,
    )
    listeners: list[StatusListener] = [
        LineListener(emit),
        StatusFileListener(tunnel_status_path(cfg)),
    ]
    client = TunnelClient(cfg, project_path=project_path, listeners=listeners)
    asyncio.run(_run_until_signalled(client))
