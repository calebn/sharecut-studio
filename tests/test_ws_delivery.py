from __future__ import annotations

import asyncio

import pytest
from starlette.websockets import WebSocket, WebSocketState

from podcast_mcp.util.ws_delivery import SerializedWsWriter


@pytest.mark.asyncio
async def test_transport_disconnect_completes_writer_without_another_close():
    entered = asyncio.Event()
    release = asyncio.Event()
    frames = []

    async def receive():
        return {"type": "websocket.connect"}

    async def send(frame):
        frames.append(frame)
        if frame.get("text") == "closing":
            entered.set()
            await release.wait()
            raise OSError("connection is closing")

    socket = WebSocket({"type": "websocket"}, receive, send)
    await socket.accept()
    writer = SerializedWsWriter(socket.send_text, socket.close)
    await writer.send("first")
    closing = asyncio.create_task(writer.send("closing"))
    await entered.wait()
    queued_entered = asyncio.Event()

    async def send_queued():
        queued_entered.set()
        await writer.send("queued")

    queued = asyncio.create_task(send_queued())
    await queued_entered.wait()
    assert not queued.done()
    release.set()
    await asyncio.wait_for(asyncio.gather(closing, queued), 0.2)
    await asyncio.wait_for(writer.wait_closed(), 0.2)
    await asyncio.wait_for(writer.close(1000, "later"), 0.2)
    await writer.send("late")
    assert writer.closed
    assert socket.application_state == WebSocketState.DISCONNECTED
    assert frames == [
        {"type": "websocket.accept", "subprotocol": None, "headers": []},
        {"type": "websocket.send", "text": "first"},
        {"type": "websocket.send", "text": "closing"},
    ]


@pytest.mark.asyncio
async def test_send_disconnect_does_not_complete_an_in_progress_close():
    write_entered = asyncio.Event()
    close_entered = asyncio.Event()
    release_close = asyncio.Event()
    frames = []

    async def receive():
        return {"type": "websocket.connect"}

    async def send(frame):
        frames.append(frame)
        if frame["type"] == "websocket.send":
            write_entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                raise OSError("connection is closing") from None
        if frame["type"] == "websocket.close":
            close_entered.set()
            await release_close.wait()

    socket = WebSocket({"type": "websocket"}, receive, send)
    await socket.accept()
    writer = SerializedWsWriter(socket.send_text, socket.close)
    writing = asyncio.create_task(writer.send("active"))
    await write_entered.wait()
    closing = asyncio.create_task(writer.close(4403, "revoked"))
    await close_entered.wait()
    waiter_entered = asyncio.Event()

    async def wait_for_close():
        waiter_entered.set()
        await writer.wait_closed()

    waiter = asyncio.create_task(wait_for_close())
    await waiter_entered.wait()
    await asyncio.wait_for(writing, 0.2)
    assert not closing.done()
    assert not waiter.done()
    release_close.set()
    await asyncio.wait_for(asyncio.gather(closing, waiter), 0.2)
    assert writer.closed
    assert frames == [
        {"type": "websocket.accept", "subprotocol": None, "headers": []},
        {"type": "websocket.send", "text": "active"},
        {"type": "websocket.close", "code": 4403, "reason": "revoked"},
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [RuntimeError("invalid send"), ValueError("invalid payload")])
async def test_unrelated_write_errors_propagate_and_leave_writer_open(error):
    sent = []
    closed = []

    async def write(value):
        if value == "invalid":
            raise error
        sent.append(value)

    async def close(code, reason):
        closed.append((code, reason))

    writer = SerializedWsWriter(write, close)
    with pytest.raises(type(error), match=str(error)):
        await writer.send("invalid")
    await writer.send("valid")
    assert sent == ["valid"]
    assert closed == []
    assert not writer.closed


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
    second_entered = asyncio.Event()

    async def send_second():
        second_entered.set()
        await writer.send("second")

    second = asyncio.create_task(send_second())
    await second_entered.wait()
    assert not second.done()
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
    get_entered = asyncio.Event()

    async def get_waiting_frame():
        get_entered.set()
        return await waiting_queue.get()

    waiting = asyncio.create_task(get_waiting_frame())
    await get_entered.wait()
    assert not waiting.done()
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


@pytest.mark.asyncio
async def test_concurrent_close_waits_for_one_delivery():
    entered = asyncio.Event()
    release = asyncio.Event()
    closes = []
    writes = []

    async def write(value):
        writes.append(value)

    async def close(code, reason):
        closes.append((code, reason))
        entered.set()
        await release.wait()

    writer = SerializedWsWriter(write, close)
    first = asyncio.create_task(writer.close(4403, "revoked"))
    await entered.wait()
    second_entered = asyncio.Event()
    completed_entered = asyncio.Event()

    async def close_again():
        second_entered.set()
        await writer.close(1011, "pump failed")

    async def wait_for_completion():
        completed_entered.set()
        await writer.wait_closed()

    second = asyncio.create_task(close_again())
    completed = asyncio.create_task(wait_for_completion())
    await second_entered.wait()
    await completed_entered.wait()
    await writer.send("late")
    assert writer.closed
    assert not second.done()
    assert not completed.done()
    release.set()
    await asyncio.wait_for(asyncio.gather(first, second, completed), 0.2)
    assert closes == [(4403, "revoked")]
    assert writes == []


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["timeout", "cancel", "error"])
async def test_close_waiters_finish_when_delivery_does_not(outcome):
    entered = asyncio.Event()
    release = asyncio.Event()

    async def write(value):
        raise AssertionError("closed connection wrote")

    async def close(code, reason):
        entered.set()
        await release.wait()
        raise RuntimeError("socket gone")

    writer = SerializedWsWriter(write, close, timeout=0.02)
    closing = asyncio.create_task(writer.close(1011, "failed"))
    await entered.wait()
    waiter = asyncio.create_task(writer.wait_closed())
    if outcome == "cancel":
        closing.cancel()
    elif outcome == "error":
        release.set()
    result, _ = await asyncio.wait_for(asyncio.gather(closing, waiter, return_exceptions=True), 0.2)
    if outcome == "cancel":
        assert isinstance(result, asyncio.CancelledError)
    elif outcome == "error":
        assert isinstance(result, RuntimeError)
    else:
        assert result is None
    await asyncio.wait_for(writer.close(1000, "later"), 0.2)
    assert writer.closed


@pytest.mark.asyncio
async def test_cancelled_close_waiter_does_not_cancel_delivery():
    entered = asyncio.Event()
    release = asyncio.Event()
    delivered = []

    async def write(value):
        raise AssertionError("closed connection wrote")

    async def close(code, reason):
        entered.set()
        await release.wait()
        delivered.append(code)

    writer = SerializedWsWriter(write, close)
    closing = asyncio.create_task(writer.close(4403, "revoked"))
    await entered.wait()
    waiter_entered = asyncio.Event()

    async def close_again():
        waiter_entered.set()
        await writer.close(1000, "later")

    waiter = asyncio.create_task(close_again())
    await waiter_entered.wait()
    assert not waiter.done()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert not closing.done()
    release.set()
    await asyncio.wait_for(closing, 0.2)
    assert delivered == [4403]
