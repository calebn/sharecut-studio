"""TunnelClient - outbound WebSocket tunnel connecting the host to the relay."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
from pathlib import Path
from typing import Any

from podcast_mcp.edits.review_shares import list_usable_shares
from podcast_mcp.edits.share_capabilities import normalize_capabilities
from podcast_mcp.models import load_project
from podcast_mcp.runtime_config import RelayConfig, load_relay_config
from podcast_mcp.util.body_limits import relay_ws_max_size
from podcast_mcp.util.proxy_paths import (
    UnsafeProxyPath,
    assert_allowed_local_gui_path,
    assert_safe_proxy_path,
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


class TunnelClient:
    """Outbound WebSocket tunnel connecting the host to the relay server."""

    def __init__(
        self,
        cfg: RelayConfig,
        project_path: Path | None = None,
    ) -> None:
        self._cfg = cfg
        self._project_path = project_path

    def _build_shares(self) -> list[dict[str, Any]]:
        if self._project_path is None:
            return []
        try:
            from podcast_relay.share_claims import attach_share_claims

            proj = load_project(self._project_path)
            rows = [
                {
                    "token": row["token"],
                    "capabilities": list(normalize_capabilities(row.get("capabilities"))),
                }
                for row in list_usable_shares(proj)
                if row.get("token")
            ]
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
        headers = {
            k: v
            for k, v in dict(request_data.get("headers") or {}).items()
            if k.lower() not in _HOP_BY_HOP
        }
        share_token = str(request_data.get("share_token") or "")
        body_b64 = str(request_data.get("body_b64") or "")
        body = base64.b64decode(body_b64) if body_b64 else None

        try:
            local_path = _map_local_path(path_suffix, share_token)
        except UnsafeProxyPath as exc:
            log.warning("Rejected unsafe proxy path %r: %s", path_suffix, exc)
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
            # Do not follow redirects: ReviewApp /audio may 302 to object storage so the
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
            log.warning("Proxy error for %s %s: %s", method, url, exc)
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
        streams: dict[str, asyncio.Queue[str | None]],
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
            log.warning("Rejected unsafe guest WS path %r: %s", path_suffix, exc)
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

        queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=256)
        streams[stream_id] = queue
        close_code = 1000
        close_reason = ""
        try:
            async with websockets.connect(
                url,
                max_size=relay_ws_max_size(),
                open_timeout=30.0,
                ping_interval=20.0,
                ping_timeout=120.0,
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
                        with contextlib.suppress(Exception):  # pragma: no cover
                            queue.put_nowait(None)

                async def _to_local() -> None:
                    while True:
                        text = await queue.get()
                        if text is None:
                            break
                        await local_ws.send(text)

                up = asyncio.create_task(_to_relay())
                down = asyncio.create_task(_to_local())
                done, pending = await asyncio.wait({up, down}, return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
                for t in done | pending:
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await t
                if up in done:
                    close_code = int(getattr(local_ws, "close_code", None) or 1000)
                    close_reason = str(getattr(local_ws, "close_reason", None) or "")
        except Exception as exc:
            log.warning("Guest WS proxy error for %s: %s", url, exc)
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
        log.info("Connecting tunnel to %s (host_id=%s)", cfg.relay_url, cfg.host_id)

        async with websockets.connect(
            cfg.relay_url,
            max_size=relay_ws_max_size(),
            open_timeout=30.0,
            ping_interval=20.0,
            ping_timeout=120.0,
        ) as ws:
            send_lock = asyncio.Lock()

            async def send(payload: dict[str, Any]) -> None:
                async with send_lock:
                    await ws.send(json.dumps(payload))

            await send(
                msg(
                    "hello",
                    host_token=cfg.host_token,
                    host_id=cfg.host_id,
                    protocol_version=PROTOCOL_VERSION,
                )
            )
            ack = json.loads(await ws.recv())
            if ack.get("type") != "hello" or not ack.get("ok"):
                raise RuntimeError(f"Relay rejected hello: {ack}")

            await send(msg("register", shares=shares))
            reg_ack = json.loads(await ws.recv())
            log.info("Registered %d shares (relay ack: %s)", len(shares), reg_ack)

            tasks: set[asyncio.Task[None]] = set()
            ws_streams: dict[str, asyncio.Queue[str | None]] = {}

            async with httpx.AsyncClient() as http_client:
                while True:
                    raw = json.loads(await ws.recv())
                    mtype = raw.get("type")
                    if mtype == "http":
                        task = asyncio.create_task(self._proxy_http(http_client, raw, send=send))
                        tasks.add(task)
                        task.add_done_callback(tasks.discard)
                    elif mtype == "ws_open":
                        task = asyncio.create_task(
                            self._proxy_ws(raw, send=send, streams=ws_streams)
                        )
                        tasks.add(task)
                        task.add_done_callback(tasks.discard)
                    elif mtype == "ws_data":
                        q = ws_streams.get(str(raw.get("id") or ""))
                        if q is not None:
                            with contextlib.suppress(Exception):  # pragma: no cover
                                q.put_nowait(str(raw.get("text") or ""))
                    elif mtype == "ws_close":
                        q = ws_streams.pop(str(raw.get("id") or ""), None)
                        if q is not None:
                            with contextlib.suppress(Exception):  # pragma: no cover
                                q.put_nowait(None)
                    elif mtype == "ping":
                        await send(msg("pong"))
                    elif mtype == "error":
                        log.error("Relay error: %s", raw.get("detail"))
                    else:
                        log.debug("Unhandled relay message type: %s", mtype)

    async def run(
        self,
        *,
        max_attempts: int | None = None,
        initial_delay_sec: float = 1.0,
        max_delay_sec: float = 60.0,
    ) -> None:
        """Connect to the relay; reconnect with backoff until cancelled.

        ``max_attempts`` limits reconnect tries after the first failure (None =
        unlimited). Clean cancellation propagates without reconnecting.
        """
        import secrets

        attempt = 0
        delay = initial_delay_sec
        rng = secrets.SystemRandom()
        while True:
            attempt += 1
            try:
                await self._run_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning(
                    "Tunnel disconnected (%s); reconnecting in %.1fs (attempt %d)",
                    exc,
                    delay,
                    attempt,
                )
                if max_attempts is not None and attempt >= max_attempts:
                    raise
            else:
                log.info("Tunnel session ended; reconnecting")
                if max_attempts is not None and attempt >= max_attempts:
                    return
            jitter = rng.uniform(0, min(1.0, delay * 0.25))
            await asyncio.sleep(delay + jitter)
            delay = min(max_delay_sec, delay * 2.0)


def run_tunnel_sync(
    project_path: Path | None = None,
    *,
    relay_url: str | None = None,
    host_token: str | None = None,
    public_base_url: str | None = None,
    local_gui_url: str | None = None,
    config_path: Path | None = None,
) -> None:
    """Block the calling thread running the tunnel client event loop."""
    cfg = load_relay_config(
        config_path,
        relay_url=relay_url,
        host_token=host_token,
        public_base_url=public_base_url,
        local_gui_url=local_gui_url,
    )
    asyncio.run(TunnelClient(cfg, project_path=project_path).run())
