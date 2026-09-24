"""Shared guest WebSocket accept/reject and share-recheck helpers."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import Any

from fastapi import WebSocket

GUEST_MALFORMED_LIMIT = 20
GUEST_SHARE_RECHECK_S = 30.0
GUEST_SHARE_RECHECK_ON_FRAME_S = 5.0


async def guest_ws_reject(websocket: WebSocket, code: int, reason: str) -> None:
    """Accept then close so TestClient/ASGI clients do not hang on handshake."""
    await websocket.accept()
    await websocket.close(code=code, reason=reason[:120])


class GuestWsGuard:
    """Write lock, malformed counter, and periodic share recheck."""

    def __init__(
        self,
        websocket: WebSocket,
        still_valid: Callable[[], bool],
        *,
        interval: float = GUEST_SHARE_RECHECK_S,
        on_frame: float = GUEST_SHARE_RECHECK_ON_FRAME_S,
        malformed_limit: int = GUEST_MALFORMED_LIMIT,
        send_gate: Callable[[], bool] | None = None,
    ) -> None:
        self.websocket = websocket
        self._still_valid = still_valid
        self._send_gate = send_gate
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
                await self.close(4403, "share revoked or expired")
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
