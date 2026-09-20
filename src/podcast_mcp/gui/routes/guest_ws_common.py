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
    ) -> None:
        self.websocket = websocket
        self._still_valid = still_valid
        self.interval = interval
        self.on_frame = on_frame
        self.malformed_limit = malformed_limit
        self.malformed = 0
        self.last_recheck = time.monotonic()
        self.write_lock = asyncio.Lock()

    async def send_json(self, payload: dict[str, Any]) -> None:
        async with self.write_lock:
            await self.websocket.send_json(payload)

    async def close(self, code: int, reason: str) -> None:
        async with self.write_lock:
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
