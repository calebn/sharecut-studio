"""Shared guest WebSocket admission, accept/reject and share-recheck helpers."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import WebSocket

from podcast_mcp.services.remote_mcp.limits import get_host_limiters, host_rate_limit_enabled
from podcast_mcp.services.share import lookup_share

log = logging.getLogger(__name__)

GUEST_MALFORMED_LIMIT = 20
GUEST_SHARE_RECHECK_S = 30.0
GUEST_SHARE_RECHECK_ON_FRAME_S = 5.0
GUEST_WS_INVALID_TOKEN_REASON = "invalid or revoked share token"
GUEST_WS_CONCURRENCY_REASON = "guest ws concurrency limit"


async def guest_ws_reject(websocket: WebSocket, code: int, reason: str) -> None:
    """Accept then close so TestClient/ASGI clients do not hang on handshake."""
    await websocket.accept()
    await websocket.close(code=code, reason=reason[:120])


class GuestWsGuard:
    """Write lock, malformed counter, and periodic re-authorization (share guests and the owner ``/api/document/ws``)."""

    def __init__(
        self,
        websocket: WebSocket,
        still_valid: Callable[[], bool],
        *,
        interval: float = GUEST_SHARE_RECHECK_S,
        on_frame: float = GUEST_SHARE_RECHECK_ON_FRAME_S,
        malformed_limit: int = GUEST_MALFORMED_LIMIT,
        send_gate: Callable[[], bool] | None = None,
        revoked_reason: str = "share revoked or expired",
    ) -> None:
        self.websocket = websocket
        self._still_valid = still_valid
        self._send_gate = send_gate
        self._revoked_reason = revoked_reason
        self.interval = interval
        self.on_frame = on_frame
        self.malformed_limit = malformed_limit
        self.malformed = 0
        self.last_recheck = time.monotonic()
        self.write_lock = asyncio.Lock()
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    async def send_json(self, payload: dict[str, Any]) -> None:
        async with self.write_lock:
            if self._closed:
                return
            if self._send_gate is not None and not self._send_gate():
                self._closed = True
                await self.websocket.close(code=4403, reason="participant removed")
                return
            await self.websocket.send_json(payload)

    async def close(self, code: int, reason: str) -> None:
        async with self.write_lock:
            if not self._closed:
                self._closed = True
                await self.websocket.close(code=code, reason=reason[:120])

    async def recheck_loop(self) -> None:
        while True:
            await asyncio.sleep(self.interval)
            if not self._still_valid():
                await self.close(4403, self._revoked_reason)
                return

    def share_ok_on_frame(self) -> bool:
        now = time.monotonic()
        if now - self.last_recheck >= self.on_frame:
            self.last_recheck = now
            if not self._still_valid():
                return False
        return True

    def note_malformed(self) -> bool:
        """Increment; return True when the connection should close."""
        self.malformed += 1
        return self.malformed > self.malformed_limit


async def guest_ws_share_row(
    websocket: WebSocket, token: str, *, kind: str
) -> dict[str, Any] | None:
    """Resolve the share row, or reject ``4403`` and return ``None``.

    Unknown, revoked, expired and wrong-kind tokens all raise ``KeyError`` in
    ``lookup_share``, so every guest socket rejects them identically here.
    """
    try:
        return lookup_share(token, kind=kind)
    except KeyError:
        await guest_ws_reject(websocket, 4403, GUEST_WS_INVALID_TOKEN_REASON)
        return None


class WsTaskSet:
    """Background tasks for one GUI WebSocket: ``spawn`` pumps, ``stop`` on teardown.

    Shared by the guest sockets (via ``GuestWsConnection``) and the owner
    ``/api/document/ws`` and ``/api/session/ws`` routes.
    """

    def __init__(self, log_label: str) -> None:
        self._log_label = log_label
        self._tasks: list[asyncio.Task[None]] = []

    def spawn(self, coro: Coroutine[Any, Any, None]) -> asyncio.Task[None]:
        task = asyncio.create_task(coro)
        self._tasks.append(task)
        return task

    async def stop(self) -> None:
        """Cancel and await every spawned task; log (never raise) task failures.

        Every task is awaited to completion first. If the coroutine calling
        ``stop`` was itself cancelled meanwhile (server shutdown, outer cancel),
        that cancel is re-raised afterwards instead of being swallowed. The
        original ``CancelledError`` is re-raised (not a fresh instance) so
        cancel-scope-based runtimes (anyio, used by Starlette's TestClient)
        still recognize it as their own cancellation and unwind cleanly.
        """
        tasks, self._tasks = self._tasks, []
        for task in tasks:
            task.cancel()
        outer_cancel: asyncio.CancelledError | None = None
        for task in tasks:
            try:
                await task
            except asyncio.CancelledError as exc:
                current = asyncio.current_task()
                if current is not None and current.cancelling():
                    outer_cancel = exc
            except Exception:
                log.exception("%s pump exit", self._log_label)
        current = asyncio.current_task()
        if current is not None and current.cancelling():
            # A cancellation aimed at *this* task may still be outstanding, or
            # may be the one just caught above from a child. Prefer catching a
            # still-undelivered one here, with its real identity intact, over
            # the substitute we may have captured above — cancel-scope-based
            # runtimes (anyio, used by Starlette's TestClient) only recognize
            # their own CancelledError instance, not a fabricated one.
            try:
                await asyncio.sleep(0)
            except asyncio.CancelledError as exc:
                outer_cancel = exc
        if outer_cancel is not None:
            raise outer_cancel


class GuestWsConnection:
    """One admitted guest socket: its concurrency slot, guard, and background tasks.

    Lifecycle: ``admit_guest_ws`` -> ``start`` (accept + guard + recheck loop) ->
    ``spawn`` pumps -> ``stop_tasks`` -> endpoint cleanup -> ``release``.
    """

    def __init__(
        self, websocket: WebSocket, token: str, *, gate_held: bool, log_label: str
    ) -> None:
        self.websocket = websocket
        self.token = token
        self._gate_held = gate_held
        self._tasks = WsTaskSet(f"{log_label} token={token[:8]}")

    async def start(
        self,
        still_valid: Callable[[], bool],
        *,
        send_gate: Callable[[], bool] | None = None,
    ) -> GuestWsGuard:
        """Accept, build the ``GuestWsGuard`` and start its periodic recheck."""
        await self.websocket.accept()
        guard = GuestWsGuard(
            self.websocket,
            still_valid,
            interval=GUEST_SHARE_RECHECK_S,
            on_frame=GUEST_SHARE_RECHECK_ON_FRAME_S,
            send_gate=send_gate,
        )
        self.spawn(guard.recheck_loop())
        return guard

    def spawn(self, coro: Coroutine[Any, Any, None]) -> asyncio.Task[None]:
        return self._tasks.spawn(coro)

    async def stop_tasks(self) -> None:
        """Cancel and await every spawned task (see ``WsTaskSet.stop``)."""
        await self._tasks.stop()

    def release(self) -> None:
        """Return the concurrency slot (idempotent)."""
        if self._gate_held:
            self._gate_held = False
            get_host_limiters().guest_ws_concurrent.exit(self.token)


async def admit_guest_ws(
    websocket: WebSocket, token: str, *, log_label: str
) -> GuestWsConnection | None:
    """Take the per-token ``PODCAST_GUEST_WS_CONCURRENT`` slot, or reject ``4429`` and return ``None``."""
    gate_held = False
    if host_rate_limit_enabled():
        if not get_host_limiters().guest_ws_concurrent.try_enter(token).allowed:
            await guest_ws_reject(websocket, 4429, GUEST_WS_CONCURRENCY_REASON)
            return None
        gate_held = True
    return GuestWsConnection(websocket, token, gate_held=gate_held, log_label=log_label)
