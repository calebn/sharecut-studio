"""Host tunnel websocket: hello, share registration and frame demultiplexing."""

from __future__ import annotations

import asyncio
import base64
import contextlib
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from podcast_mcp.util.relay_protocol.lease import (
    LEASE_EXPIRED_CLOSE_REASON,
    LeaseError,
    LeaseRefusal,
)
from podcast_mcp.util.relay_protocol.protocol import msg, new_id
from podcast_mcp.util.ws_delivery import ws_close_details
from podcast_relay.limits import check_register
from podcast_relay.state import (
    PendingHttp,
    RelayState,
    TunnelRefused,
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


async def _close_at_expiry(state: RelayState, session: TunnelSession, exp: int) -> None:
    """End a lease tunnel when its lease does, so a live tunnel never outlives its credential.

    The host's keep-alive renewal has already swapped in a fresh lease by then, and its
    reconnect says hello with that one.
    """
    assert state.policy is not None
    await asyncio.sleep(max(0.0, exp - state.policy.clock()))
    with contextlib.suppress(Exception):
        await session.writer.close(4403, LEASE_EXPIRED_CLOSE_REASON)


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
            lease_token = str(first.get("lease") or "")
            install_id = ""
            lease_exp = 0
            if lease_token:
                try:
                    if state.policy is None:
                        raise LeaseError(LeaseRefusal.UNKNOWN_KID)
                    lease = state.policy.check(lease_token, install_id=host_id)
                    install_id, lease_exp = lease.install_id, lease.exp
                except LeaseError as exc:
                    await websocket.send_json(
                        msg("error", detail=f"lease_refused:{exc.refusal.value}")
                    )
                    await websocket.close(code=4403)
                    return
                host_token = ""
            if not install_id and state.meter is not None and not state.meter.config.legacy_enabled:
                await websocket.send_json(msg("error", detail="legacy_tier_ended"))
                await websocket.close(code=4403)
                return
            reg_key = install_id or host_token
            reg = check_register(reg_key)
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
            if not install_id and not state.token_ok(host_token, host_id=host_id):
                await websocket.send_json(msg("error", detail="invalid host_token for host_id"))
                await websocket.close(code=4403)
                return
            session = TunnelSession(
                host_id=host_id,
                websocket=websocket,
                host_token=host_token,
                install_id=install_id,
                meter=state.meter.session(
                    install_id=install_id,
                    host_token=host_token,
                    client_ip=websocket.client.host if websocket.client else "",
                )
                if state.meter is not None
                else None,
            )
            try:
                await state.register_tunnel(session)
            except TunnelRefused as refused:
                session = None
                await websocket.send_json(msg("error", detail=refused.detail, **refused.frame))
                await websocket.close(code=refused.code)
                return
            await session.send(msg("hello", host_id=host_id, ok=True))

            async def _pump_to_host() -> None:
                assert session is not None
                while True:
                    payload = await session.to_host.get()
                    if payload is None:
                        break
                    await session.send(payload)

            host_pump = asyncio.create_task(_pump_to_host())
            expiry = (
                asyncio.create_task(_close_at_expiry(state, session, lease_exp))
                if lease_exp
                else None
            )
            try:
                while True:
                    data = await websocket.receive_json()
                    mtype = data.get("type")
                    if mtype == "register":
                        reg2 = check_register(reg_key)
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
                        session.limit_kind = state.limit_kind(session)
                        ack = msg("register", ok=True, share_count=len(session.share_tokens))
                        if session.limit_kind:
                            ack["limited"] = session.limit_kind
                            ack["refused"] = session.refused_shares
                        await session.send(ack)
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
                for task in filter(None, (host_pump, expiry)):
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await task
        except WebSocketDisconnect:
            pass
        finally:
            # host_id is read before auth; only tear down a tunnel this socket registered
            # so a rejected hello cannot evict a live host presenting the same host_id.
            if session is not None:
                await state.unregister_tunnel(session.host_id, expected_session=session)

    return router
