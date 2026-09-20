"""Guest MCP ``notifications/progress`` sink for Streamable HTTP SSE."""

from __future__ import annotations

import asyncio
import contextlib
import json
import threading
from collections.abc import AsyncIterator
from typing import Any

from podcast_mcp.services.guest_progress import scrub_guest_progress_text
from podcast_mcp.util.progress import _mcp_progress_token, short_fail_headline

_SSE_DONE = object()
_MCP_SSE_QUEUE_MAX = 64


class McpProgressSink:
    """Thread-safe writer of JSON-RPC notification dicts onto an asyncio queue."""

    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        queue: asyncio.Queue[Any],
    ) -> None:
        self._loop = loop
        self._queue = queue
        self._lock = threading.Lock()
        self._closed = False

    def emit(self, payload: dict[str, Any]) -> None:
        with self._lock:
            if self._closed:
                return

        def _put() -> None:
            with self._lock:
                if self._closed:
                    return
            try:
                self._queue.put_nowait(payload)
            except asyncio.QueueFull:
                with contextlib.suppress(asyncio.QueueEmpty):
                    self._queue.get_nowait()
                with contextlib.suppress(asyncio.QueueFull):
                    self._queue.put_nowait(payload)

        with contextlib.suppress(RuntimeError):
            self._loop.call_soon_threadsafe(_put)

    def close(self) -> None:
        with self._lock:
            self._closed = True


class GuestMcpProgressContext:
    """JSON-RPC progressToken + live ``notifications/progress`` emit."""

    def __init__(
        self,
        progressToken: Any,
        sink: McpProgressSink | None = None,
    ) -> None:
        self.progressToken = progressToken
        self.notifications: list[dict[str, Any]] = []
        self._sink = sink
        self._lock = threading.Lock()
        self._closed = False
        self._current = 0.0
        self._total: float | None = None
        self._label = ""

    @property
    def progress_token(self) -> Any:
        return self.progressToken

    def close(self) -> None:
        with self._lock:
            self._closed = True
        if self._sink is not None:
            self._sink.close()

    def report_progress(
        self,
        progress: float,
        total: float | None = None,
        message: str | None = None,
    ) -> None:
        payload = {
            "jsonrpc": "2.0",
            "method": "notifications/progress",
            "params": {
                "progressToken": self.progressToken,
                "progress": progress,
                "total": total,
                "message": scrub_guest_progress_text(message),
            },
        }
        with self._lock:
            if self._closed:
                return
            self.notifications.append(payload)
            sink = self._sink
        if sink is not None:
            sink.emit(payload)

    def start(self, task_id: str, label: str, total: int | None = None) -> None:
        del task_id
        self._label = label
        self._current = 0.0
        self._total = float(total) if total is not None else None
        self.report_progress(0.0, self._total, label)

    def update(
        self,
        task_id: str,
        current: int,
        *,
        total: int | None = None,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        del task_id, phase
        self._current = float(current)
        if total is not None:
            self._total = float(total)
        self.report_progress(self._current, self._total, message or self._label)

    def message(self, task_id: str, text: str, *, phase: str | None = None) -> None:
        del task_id, phase
        self.report_progress(self._current, self._total, text)

    def heartbeat(self, task_id: str, *, message: str | None = None) -> None:
        del task_id
        self.report_progress(self._current, self._total, message or self._label)

    def end(self, task_id: str, *, message: str | None = None) -> None:
        del task_id
        done = self._total if self._total is not None else self._current
        self.report_progress(done, self._total, message or "done")

    def fail(
        self,
        task_id: str,
        *,
        message: str | None = None,
        phase: str | None = None,
    ) -> None:
        del task_id
        short = short_fail_headline(message, phase) or "failed"
        self.report_progress(self._current, self._total, short)

    def cancel(self, task_id: str, *, message: str | None = None) -> None:
        del task_id
        self.report_progress(self._current, self._total, message or "cancelled")


def format_mcp_sse(payload: dict[str, Any]) -> str:
    """One Streamable HTTP ``message`` event wrapping a JSON-RPC object."""
    data = json.dumps(payload, default=str)
    return f"event: message\ndata: {data}\n\n"


def rpc_progress_token(message: dict[str, Any]) -> Any:
    """Read ``params._meta.progressToken`` from a JSON-RPC request body."""
    params = message.get("params")
    return _mcp_progress_token(params)


def _error_payload(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": code, "message": message},
    }


async def iter_mcp_sse(token: str, body: dict[str, Any]) -> AsyncIterator[str]:
    """Yield SSE frames: notifications as they happen, then the JSON-RPC result."""
    from podcast_mcp.services.remote_mcp.protocol import handle_mcp_jsonrpc

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=_MCP_SSE_QUEUE_MAX)
    sink = McpProgressSink(loop, queue)
    yield ": progress\n\n"
    fut = loop.run_in_executor(
        None,
        lambda: handle_mcp_jsonrpc(token, body, progress_sink=sink),
    )
    result: dict[str, Any] | None = None
    err: BaseException | None = None

    async def _finish() -> None:
        nonlocal result, err
        try:
            result = await fut
        except BaseException as exc:
            err = exc
        await asyncio.sleep(0)
        sink.close()
        try:
            queue.put_nowait(_SSE_DONE)
        except asyncio.QueueFull:
            with contextlib.suppress(asyncio.QueueEmpty):
                queue.get_nowait()
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(_SSE_DONE)

    finisher = asyncio.create_task(_finish())
    try:
        while True:
            item = await queue.get()
            if item is _SSE_DONE:
                break
            if isinstance(item, dict):
                yield format_mcp_sse(item)
        if err is not None:
            yield format_mcp_sse(_error_payload(body.get("id"), -32000, str(err)))
        elif result is not None:
            yield format_mcp_sse(result)
    finally:
        sink.close()
        if not finisher.done():
            finisher.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await finisher
