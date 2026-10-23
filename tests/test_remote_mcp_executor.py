from __future__ import annotations

import asyncio
import threading

from podcast_mcp.services.remote_mcp import executor as guest_executor


def test_run_guest_mcp_call_runs_on_named_guest_pool():
    async def main() -> str:
        return await guest_executor.run_guest_mcp_call(lambda: threading.current_thread().name)

    assert asyncio.run(main()).startswith("guest-mcp")


def test_run_guest_mcp_call_caps_concurrency():
    limit = guest_executor.GUEST_MCP_MAX_WORKERS
    release = threading.Event()
    guard = threading.Condition()
    entered: set[threading.Thread] = set()
    active = 0
    peak = 0
    completed = 0

    def work() -> None:
        nonlocal active, peak, completed
        with guard:
            entered.add(threading.current_thread())
            active += 1
            peak = max(peak, active)
            guard.notify_all()
        try:
            assert release.wait(timeout=15), "worker release timed out"
        finally:
            with guard:
                active -= 1
                completed += 1
                guard.notify_all()

    async def main() -> None:
        futs: list[asyncio.Future[None]] = []
        try:
            for _ in range(limit + 2):
                futs.append(guest_executor.run_guest_mcp_call(work))
            # CPython registers each executor thread synchronously during submission.
            workers = set(guest_executor._EXECUTOR._threads)
            with guard:
                assert guard.wait_for(lambda: workers <= entered, timeout=5), (
                    "workers did not enter"
                )
                assert active == limit
                assert guest_executor._EXECUTOR._work_queue.qsize() == 2
        finally:
            release.set()
            try:
                await asyncio.wait_for(asyncio.gather(*futs), timeout=5)
            finally:
                with guard:
                    assert guard.wait_for(lambda: completed == len(futs), timeout=5), (
                        "workers did not complete"
                    )

    asyncio.run(main())
    assert peak == limit
