"""Host tunnel websocket: hello, share registration and frame demultiplexing."""

from __future__ import annotations

import asyncio
import base64
import contextlib
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from podcast_mcp.util.relay_protocol.protocol import msg, new_id
from podcast_mcp.util.ws_delivery import ws_close_details
from podcast_relay.limits import check_register
from podcast_relay.state import (
    PendingHttp,
    RelayState,
    TunnelSession,
    close_relay_guest_stream,
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


def build_tunnel_router(state: RelayState) -> APIRouter:
    router = APIRouter()

    @router.websocket("/tunnel")
    async def tunnel_ws(websocket: WebSocket) -> None:
        await websocket.accept()
        session: TunnelSession | None = None
        try:
            first = await websocket.receive_json()
            if first.get("type") != "hello":
                await websocket.send_json(msg("error", detail="expected hello"))
                await websocket.close(code=4400)
                return
            host_token = str(first.get("host_token") or "")
            host_id = str(first.get("host_id") or new_id())
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
            await session.send(msg("hello", host_id=host_id, ok=True))

            async def _pump_to_host() -> None:
                assert session is not None
                while True:
                    payload = await session.to_host.get()
                    if payload is None:
                        break
                    await session.send(payload)

            host_pump = asyncio.create_task(_pump_to_host())
            try:
                while True:
                    data = await websocket.receive_json()
                    mtype = data.get("type")
                    if mtype == "register":
                        reg2 = check_register(host_token)
                        if not reg2.allowed:
                            await session.send(
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
                        await state.update_shares(host_id, shares, expected_session=session)
                        await session.send(
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
                            try:
                                stream.queue.put_nowait(str(data.get("text") or ""))
                            except asyncio.QueueFull:
                                close_relay_guest_stream(
                                    stream,
                                    "relay.guest_backlog_full",
                                    1013,
                                    "guest backlog full",
                                    share_token=session.ws_stream_tokens.get(
                                        str(data.get("id") or ""), ""
                                    ),
                                    stream_id=str(data.get("id") or ""),
                                    discard=True,
                                )
                                await session.enqueue_to_host(
                                    msg(
                                        "ws_close",
                                        id=str(data.get("id") or ""),
                                        code=1013,
                                        reason="guest backlog full",
                                    )
                                )
                    elif mtype == "ws_close":
                        stream_id = str(data.get("id") or "")
                        stream = session.ws_streams.pop(stream_id, None)
                        if stream is not None:
                            code, reason = ws_close_details(data.get("code"), data.get("reason"))
                            close_relay_guest_stream(
                                stream,
                                "relay.host_ws_close",
                                code,
                                reason,
                                share_token=session.ws_stream_tokens.pop(stream_id, ""),
                                stream_id=stream_id,
                            )
                    elif mtype == "ping":
                        await session.send(msg("pong"))
                    elif mtype == "pong":
                        pass
                    else:
                        await session.send(msg("error", detail=f"unknown type {mtype!r}"))
            finally:
                session.to_host.close(discard=True)
                if not host_pump.done():
                    host_pump.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await host_pump
        except WebSocketDisconnect:
            pass
        finally:
            # host_id is read before auth; only tear down a tunnel this socket registered
            # so a rejected hello cannot evict a live host presenting the same host_id.
            if session is not None:
                await state.unregister_tunnel(session.host_id, expected_session=session)

    return router
