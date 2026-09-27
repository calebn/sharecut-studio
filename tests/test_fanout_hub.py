"""FanoutHub delivers each subscriber's events on the loop it subscribed with."""

from __future__ import annotations

import asyncio

from podcast_mcp.services.fanout_hub import FanoutHub


def _tick(loop: asyncio.AbstractEventLoop) -> None:
    loop.run_until_complete(asyncio.sleep(0))


def test_publish_delivers_on_each_subscribers_own_loop() -> None:
    hub = FanoutHub()
    loop_a, loop_b = asyncio.new_event_loop(), asyncio.new_event_loop()
    try:
        qa = hub.subscribe("k", loop_a)
        qb = hub.subscribe("k", loop_b)
        hub.publish("k", {"n": 1})
        _tick(loop_a)
        assert qa.get_nowait() == {"n": 1}
        assert qb.empty()  # not delivered via loop_a
        _tick(loop_b)
        assert qb.get_nowait() == {"n": 1}
    finally:
        loop_a.close()
        loop_b.close()


def test_publish_skips_a_closed_loop_and_still_delivers_to_others() -> None:
    hub = FanoutHub()
    closed, live = asyncio.new_event_loop(), asyncio.new_event_loop()
    try:
        hub.subscribe("k", closed)
        q = hub.subscribe("k", live)
        closed.close()
        hub.publish("k", {"n": 2})
        _tick(live)
        assert q.get_nowait() == {"n": 2}
    finally:
        live.close()


def test_unsubscribe_last_queue_clears_key_and_notifies_once() -> None:
    seen: list[str] = []
    hub = FanoutHub(on_unsubscribed=seen.append)
    loop = asyncio.new_event_loop()
    try:
        q1 = hub.subscribe("k", loop)
        q2 = hub.subscribe("k", loop)
        assert hub.listener_count("k") == 2
        hub.unsubscribe("k", q1)
        assert seen == []
        hub.unsubscribe("k", q2)
        assert seen == ["k"]
        assert hub.listener_count("k") == 0
        hub.publish("k", {"n": 3})  # no subscribers: no-op
    finally:
        loop.close()
