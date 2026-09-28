"""Guest remote-MCP worker pool."""

from __future__ import annotations

import asyncio
import threading
import time

from podcast_mcp.services.remote_mcp import executor as guest_executor


def test_run_guest_mcp_call_runs_on_named_guest_pool():
    async def main() -> str:
        return await guest_executor.run_guest_mcp_call(lambda: threading.current_thread().name)

    assert asyncio.run(main()).startswith("guest-mcp")


def test_run_guest_mcp_call_caps_concurrency():
    limit = guest_executor.GUEST_MCP_MAX_WORKERS
    release = threading.Event()
    guard = threading.Lock()
    active = 0
    peak = 0

    def work() -> None:
        nonlocal active, peak
        with guard:
            active += 1
            peak = max(peak, active)
        release.wait(timeout=5)
        with guard:
            active -= 1

    async def main() -> None:
        futs = [guest_executor.run_guest_mcp_call(work) for _ in range(limit + 2)]
        deadline = time.monotonic() + 5
        while active < limit and time.monotonic() < deadline:
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.05)
        release.set()
        await asyncio.gather(*futs)

    asyncio.run(main())
    assert peak == limit
