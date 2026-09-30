from __future__ import annotations

import asyncio

import pytest

from podcast_mcp.util.ws_delivery import SerializedWsWriter


@pytest.mark.asyncio
async def test_serializes_writes_and_preserves_order():
    entered = asyncio.Event()
    release = asyncio.Event()
    sent: list[str] = []
    closed: list[tuple[int, str]] = []

    async def write(value: str) -> None:
        if value == "first":
            entered.set()
            await release.wait()
        sent.append(value)

    async def close(code: int, reason: str) -> None:
        closed.append((code, reason))

    writer = SerializedWsWriter(write, close)
    first = asyncio.create_task(writer.send("first"))
    await entered.wait()
    second = asyncio.create_task(writer.send("second"))
    await asyncio.sleep(0)
    assert sent == []
    release.set()
    await asyncio.gather(first, second)
    assert sent == ["first", "second"]
    assert closed == []


@pytest.mark.asyncio
async def test_blocked_send_times_out_and_future_writes_are_rejected():
    closed: list[tuple[int, str]] = []
    writes: list[str] = []
    stopped = asyncio.Event()

    async def write(value: str) -> None:
        writes.append(value)
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    async def close(code: int, reason: str) -> None:
        closed.append((code, reason))

    writer = SerializedWsWriter(write, close, timeout=0.02)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(writer.send("blocked"), timeout=0.2)
    await writer.send("late")
    assert stopped.is_set()
    assert writer.closed
    assert writes == ["blocked"]
    assert closed == [(1013, "slow consumer")]


@pytest.mark.asyncio
async def test_lock_wait_is_part_of_deadline():
    entered = asyncio.Event()
    closed: list[tuple[int, str]] = []
    writes: list[str] = []

    async def write(value: str) -> None:
        writes.append(value)
        entered.set()
        await asyncio.Event().wait()

    async def close(code: int, reason: str) -> None:
        closed.append((code, reason))

    writer = SerializedWsWriter(write, close, timeout=0.05)
    first = asyncio.create_task(writer.send("first"))
    await entered.wait()
    second = asyncio.create_task(writer.send("waiting"))
    results = await asyncio.wait_for(asyncio.gather(first, second, return_exceptions=True), 0.2)
    assert any(isinstance(result, TimeoutError) for result in results)
    assert writes == ["first"]
    assert closed == [(1013, "slow consumer")]
    assert writer.closed


@pytest.mark.asyncio
async def test_revocation_cancels_blocked_write_without_waiting_for_its_lock():
    entered = asyncio.Event()
    stopped = asyncio.Event()
    closed: list[tuple[int, str]] = []

    async def write(_value: str) -> None:
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    async def close(code: int, reason: str) -> None:
        closed.append((code, reason))

    writer = SerializedWsWriter(write, close, timeout=0.05)
    active = asyncio.create_task(writer.send("blocked"))
    await entered.wait()
    await asyncio.wait_for(writer.close(4403, "revoked"), 0.2)
    with pytest.raises(asyncio.CancelledError):
        await active
    await writer.close(1000, "later")
    assert stopped.is_set()
    assert closed == [(4403, "revoked")]


@pytest.mark.asyncio
async def test_close_has_its_own_deadline_and_truncates_reason():
    reasons: list[str] = []

    async def write(_value: str) -> None:
        raise AssertionError("closed connections cannot write")

    async def close(_code: int, reason: str) -> None:
        reasons.append(reason)
        await asyncio.Event().wait()

    writer = SerializedWsWriter(write, close, timeout=0.02)
    await asyncio.wait_for(writer.close(1000, "x" * 200), 0.2)
    await writer.send("late")
    assert writer.closed
    assert reasons == ["x" * 120]


@pytest.mark.asyncio
async def test_close_reason_fits_wire_limit_without_splitting_unicode():
    reasons: list[str] = []

    async def write(_value: str) -> None:
        raise AssertionError("closed connections cannot write")

    async def close(_code: int, reason: str) -> None:
        reasons.append(reason)

    writer = SerializedWsWriter(write, close)
    await writer.close(1013, "🙂" * 100)
    assert reasons == ["🙂" * 30]
    assert len(reasons[0].encode("utf-8")) == 120


def test_queue_enforces_count_without_dropping_accepted_frames():
    from podcast_mcp.util.ws_delivery import WsFrameQueue

    queue = WsFrameQueue(len, maxsize=2, max_bytes=20)
    queue.put_nowait("first")
    queue.put_nowait("second")
    with pytest.raises(asyncio.QueueFull):
        queue.put_nowait("third")
    assert queue.qsize() == 2
    assert queue.queued_bytes == 11
    assert queue.get_nowait() == "first"
    assert queue.get_nowait() == "second"
    assert queue.queued_bytes == 0
    queue.put_nowait("later")
    assert queue.get_nowait() == "later"


def test_queue_counts_utf8_bytes_and_oversize_frames():
    from podcast_mcp.util.ws_delivery import WsFrameQueue

    queue = WsFrameQueue(lambda frame: len(frame.encode("utf-8")), maxsize=5, max_bytes=5)
    queue.put_nowait("é")
    queue.put_nowait("cat")
    assert queue.full()
    assert queue.queued_bytes == 5
    with pytest.raises(asyncio.QueueFull):
        queue.put_nowait("a")
    assert queue.get_nowait() == "é"
    with pytest.raises(asyncio.QueueFull):
        queue.put_nowait("four")
    assert queue.get_nowait() == "cat"
    with pytest.raises(asyncio.QueueFull):
        queue.put_nowait("abcdef")
    assert queue.empty()


@pytest.mark.asyncio
async def test_queue_close_delivers_ordered_frames_and_wakes_waiter():
    from podcast_mcp.util.ws_delivery import WsFrameQueue

    queue = WsFrameQueue(len, maxsize=1, max_bytes=10)
    await queue.put("accepted")
    queue.close()
    assert await queue.get() == "accepted"
    assert await queue.get() is None
    assert await queue.get() is None
    assert queue.queued_bytes == 0
    with pytest.raises(asyncio.QueueFull):
        queue.put_nowait("late")

    waiting_queue = WsFrameQueue(len, maxsize=1, max_bytes=10)
    waiting = asyncio.create_task(waiting_queue.get())
    await asyncio.sleep(0)
    waiting_queue.close(discard=True)
    assert await asyncio.wait_for(waiting, 0.2) is None


def test_stream_overflow_close_releases_retained_frames():
    from podcast_mcp.util.ws_delivery import TextWsStream, WsFrameQueue

    stream = TextWsStream(queue=WsFrameQueue(len, maxsize=1, max_bytes=10))
    stream.queue.put_nowait("accepted")
    stream.close(1013, "overflow", discard=True)
    assert stream.queue.queued_bytes == 0
    assert stream.queue.get_nowait() is None
    assert (stream.close_code, stream.close_reason) == (1013, "overflow")


@pytest.mark.parametrize("code", [1004, 1005, 1006, 1015, 2000, 5000, "1013", None])
def test_reserved_or_invalid_close_codes_use_normal_close(code):
    from podcast_mcp.util.ws_delivery import ws_close_details

    assert ws_close_details(code, "reason") == (1000, "reason")


def test_close_reason_replaces_json_lone_surrogates():
    import json

    from podcast_mcp.util.ws_delivery import ws_close_details

    reason = json.loads('"\\ud800"')
    assert ws_close_details(1013, reason) == (1013, "?")
