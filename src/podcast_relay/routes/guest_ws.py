"""Guest websocket bridge: review DAW and recording sockets relayed over the host tunnel."""

from __future__ import annotations

import asyncio
import contextlib

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from podcast_mcp.util.relay_protocol.protocol import msg, new_id
from podcast_mcp.util.ws_delivery import SerializedWsWriter
from podcast_mcp.util.ws_delivery import TextWsStream as GuestWsStream
from podcast_mcp.util.ws_limits import GUEST_FRAME_MAX_BYTES
from podcast_relay.limits import (
    get_relay_limiters,
    is_presence_ws_text,
    relay_rate_limit_enabled,
)
from podcast_relay.state import RelayState, close_relay_guest_stream


async def bridge_guest_ws(
    state: RelayState,
    websocket: WebSocket,
    token: str,
    *,
    path: str,
    required_cap: str,
) -> None:
    """Bridge a guest WS through the host tunnel (text frames only).

    The query string rides in ``ws_open`` as it does in ``http`` frames, so the host sees the
    guest's ``client_id`` and ``name``.
    """

    async def _reject(code: int, reason: str) -> None:
        await websocket.accept()
        await websocket.close(code=code, reason=reason[:120])

    session = state.tunnel_for_token(token)
    if session is None:
        await _reject(1013, "host offline")
        return
    caps = session.capabilities.get(token) or []
    if caps and required_cap not in caps:
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
    session.ws_stream_tokens[stream_id] = token

    async def close_guest(code: int, reason: str) -> None:
        await websocket.close(code=code, reason=reason)

    guest_writer = SerializedWsWriter(websocket.send_text, close_guest)
    try:
        await session.enqueue_to_host(
            msg(
                "ws_open",
                id=stream_id,
                path=path,
                query=str(websocket.url.query or ""),
                share_token=token,
            )
        )

        async def _pump_to_guest() -> None:
            try:
                while True:
                    text = await stream.queue.get()
                    if text is None:
                        break
                    await guest_writer.send(text)
            except TimeoutError:
                close_relay_guest_stream(
                    stream,
                    "relay.pump_to_guest_slow_consumer",
                    1013,
                    "slow consumer",
                    share_token=token,
                    stream_id=stream_id,
                    discard=True,
                )

        pump = asyncio.create_task(_pump_to_guest())
        recv = asyncio.create_task(websocket.receive_text())

        async def close_stream() -> None:
            await stream.closed.wait()
            if stream.close_code == 1000:
                await pump
            await guest_writer.close(stream.close_code, stream.close_reason)

        closing = asyncio.create_task(close_stream())
        try:
            while True:
                done, _pending = await asyncio.wait(
                    {pump, recv, closing}, return_when=asyncio.FIRST_COMPLETED
                )
                if pump in done or closing in done:
                    break
                if recv in done:
                    try:
                        text = recv.result()
                    except WebSocketDisconnect:
                        break
                    except Exception:
                        break
                    if len(text.encode("utf-8")) > GUEST_FRAME_MAX_BYTES:
                        await guest_writer.close(4400, "frame too large")
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
            if not closing.done():
                closing.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await pump
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await recv
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await closing
    except asyncio.QueueFull:
        close_relay_guest_stream(
            stream,
            "relay.tunnel_backlog_full",
            1013,
            "tunnel backlog full",
            share_token=token,
            stream_id=stream_id,
            discard=True,
        )
    finally:
        session.ws_streams.pop(stream_id, None)
        session.ws_stream_tokens.pop(stream_id, None)
        with contextlib.suppress(Exception):
            await session.enqueue_to_host(
                msg("ws_close", id=stream_id, code=stream.close_code, reason=stream.close_reason)
            )
        with contextlib.suppress(Exception):
            await guest_writer.close(stream.close_code, stream.close_reason)
        if gate_held:
            get_relay_limiters().ws_concurrent.exit(token)


def build_guest_ws_router(state: RelayState) -> APIRouter:
    router = APIRouter()

    @router.websocket("/api/review/{token}/daw/ws")
    async def guest_daw_ws(websocket: WebSocket, token: str) -> None:
        await bridge_guest_ws(
            state, websocket, token, path="api/review/daw/ws", required_cap="view"
        )

    @router.websocket("/api/rec/{token}/ws")
    async def record_guest_ws(websocket: WebSocket, token: str) -> None:
        await bridge_guest_ws(state, websocket, token, path="api/rec/ws", required_cap="monitor")

    return router
