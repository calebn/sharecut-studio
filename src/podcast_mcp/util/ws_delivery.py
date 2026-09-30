from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Generic, TypeVar

from podcast_mcp.util.body_limits import relay_ws_max_size

WS_SEND_TIMEOUT_S = 5.0
T = TypeVar("T")


class SerializedWsWriter(Generic[T]):
    """One connection's write owner. Closing cancels its blocked active write."""

    def __init__(
        self,
        write: Callable[[T], Awaitable[None]],
        close: Callable[[int, str], Awaitable[None]],
        *,
        timeout: float = WS_SEND_TIMEOUT_S,
    ) -> None:
        self._write = write
        self._close = close
        self._timeout = timeout
        self._lock = asyncio.Lock()
        self._active: asyncio.Task[object] | None = None
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    async def send(self, payload: T) -> None:
        try:
            async with asyncio.timeout(self._timeout):
                async with self._lock:
                    if self._closed:
                        return
                    self._active = asyncio.current_task()
                    try:
                        await self._write(payload)
                    finally:
                        self._active = None
        except TimeoutError:
            await self.close(1013, "slow consumer")
            raise

    async def close(self, code: int, reason: str) -> None:
        if self._closed:
            return
        self._closed = True
        active = self._active
        if active is not None and active is not asyncio.current_task():
            active.cancel()
        try:
            async with asyncio.timeout(self._timeout):
                await self._close(
                    code, reason.encode("utf-8")[:120].decode("utf-8", errors="ignore")
                )
        except TimeoutError:
            return


class WsFrameQueue(Generic[T]):
    """A single-consumer queue bounded by frame count and encoded bytes."""

    def __init__(
        self,
        frame_bytes: Callable[[T], int],
        *,
        maxsize: int = 256,
        max_bytes: int,
    ) -> None:
        self.maxsize = maxsize
        self.max_bytes = max_bytes
        self._frame_bytes = frame_bytes
        self._queue: asyncio.Queue[tuple[T, int] | None] = asyncio.Queue()
        self._bytes = 0
        self._closed = False

    @property
    def queued_bytes(self) -> int:
        return self._bytes

    def qsize(self) -> int:
        return self._queue.qsize()

    def empty(self) -> bool:
        return self._queue.empty()

    def full(self) -> bool:
        return self.qsize() >= self.maxsize or self._bytes >= self.max_bytes

    def put_nowait(self, frame: T | None) -> None:
        if frame is None:
            self.close()
            return
        size = self._frame_bytes(frame)
        if self._closed or self.qsize() >= self.maxsize or self._bytes + size > self.max_bytes:
            raise asyncio.QueueFull
        self._queue.put_nowait((frame, size))
        self._bytes += size

    async def put(self, frame: T | None) -> None:
        self.put_nowait(frame)

    def _take(self, item: tuple[T, int] | None) -> T | None:
        if item is None:
            return None
        frame, size = item
        self._bytes -= size
        return frame

    async def get(self) -> T | None:
        if self._closed and self.empty():
            return None
        return self._take(await self._queue.get())

    def get_nowait(self) -> T | None:
        if self._closed and self.empty():
            return None
        return self._take(self._queue.get_nowait())

    def close(self, *, discard: bool = False) -> None:
        if discard:
            while not self._queue.empty():
                self._queue.get_nowait()
            self._bytes = 0
        if not self._closed or discard:
            self._closed = True
            self._queue.put_nowait(None)


@dataclass
class TextWsStream:
    """Queued text frames and the terminal reason for a multiplexed stream."""

    queue: WsFrameQueue[str] = field(
        default_factory=lambda: WsFrameQueue(
            lambda frame: len(frame.encode("utf-8")), max_bytes=relay_ws_max_size()
        )
    )
    close_code: int = 1000
    close_reason: str = ""
    closed: asyncio.Event = field(default_factory=asyncio.Event)

    def close(self, code: int = 1000, reason: str = "", *, discard: bool = False) -> None:
        if self.close_code == 1000:
            self.close_code = code
            self.close_reason = reason[:120]
        self.queue.close(discard=discard)
        self.closed.set()
