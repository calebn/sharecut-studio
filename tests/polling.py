"""Wait on a state, not on a fixed time: poll a condition until it holds or the deadline passes."""

from __future__ import annotations

import asyncio
import contextlib
import threading
import time
from collections.abc import Callable
from typing import Any

_STEP_SEC = 0.02


def wait_for(check: Callable[[], Any], *, timeout: float = 10.0) -> Any:
    """The first truthy value ``check`` returns within ``timeout``, else its last value."""
    deadline = time.monotonic() + timeout
    idle = threading.Event()
    while not (value := check()) and time.monotonic() < deadline:
        idle.wait(_STEP_SEC)
    return value


async def until(check: Callable[[], Any], *, timeout: float = 5.0) -> None:
    """Return once ``check`` is truthy. Raises ``TimeoutError`` at the deadline."""
    async with asyncio.timeout(timeout):
        while not check():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(asyncio.Event().wait(), _STEP_SEC)


async def yield_to_loop(turns: int = 3) -> None:
    """Let every task that is ready run, so a task created a moment ago has started."""
    loop = asyncio.get_running_loop()
    for _ in range(turns):
        turn = loop.create_future()
        loop.call_soon(turn.set_result, None)
        await turn
