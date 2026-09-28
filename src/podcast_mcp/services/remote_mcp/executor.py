"""Bounded worker pool for guest remote-MCP JSON-RPC calls (JSON and SSE paths).

A guest tool call may wait up to 30 s on ``project_commit_lock`` / ``render_lock``. Running it
on this dedicated pool keeps it off the event loop and out of the AnyIO worker pool that
FastAPI's synchronous host routes share, so busy guests queue here instead of starving host
requests.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import TypeVar

T = TypeVar("T")

GUEST_MCP_MAX_WORKERS = 8

_EXECUTOR = ThreadPoolExecutor(max_workers=GUEST_MCP_MAX_WORKERS, thread_name_prefix="guest-mcp")


def run_guest_mcp_call(fn: Callable[[], T]) -> asyncio.Future[T]:
    """Run ``fn`` on the guest MCP pool; await the returned future from the running loop."""
    return asyncio.get_running_loop().run_in_executor(_EXECUTOR, fn)
