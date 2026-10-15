from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any

from podcast_mcp.gui.bootstrap_jobs import BootstrapJob
from podcast_mcp.gui.job_events import (
    JOB_EVENT_QUEUE_MAX,
    LIVE_JOB_STATUSES,
    TERMINAL_JOB_STATUSES,
    job_events_hub,
    job_listener_count,
    publish_job_event,
    stream_job_events,
)
from podcast_mcp.gui.jobs import PipelineJob


@dataclass
class _FakeJob:
    id: str
    status: str = "running"

    def snapshot(self) -> dict[str, Any]:
        return {"id": self.id, "status": self.status}


async def _collect(job: Any, *, keepalive_sec: float = 5.0, limit: int | None = None) -> list[dict]:
    out: list[dict] = []
    async for frame in stream_job_events(job, keepalive_sec=keepalive_sec):
        payload = json.loads(frame.removeprefix("data: ").strip())
        out.append(payload)
        if limit is not None and len(out) >= limit:
            break
    return out


def test_two_concurrent_subscribers_each_get_the_full_stream() -> None:
    job = PipelineJob(
        id="two-subs",
        project_path="/tmp/p.json",
        from_step=None,
        only_step=None,
        status="running",
        started_at=time.monotonic(),
    )

    async def scenario() -> tuple[list[dict], list[dict]]:
        stream_a = stream_job_events(job, keepalive_sec=5.0)
        stream_b = stream_job_events(job, keepalive_sec=5.0)
        try:
            initial_a = json.loads((await stream_a.__anext__()).removeprefix("data: ").strip())
            initial_b = json.loads((await stream_b.__anext__()).removeprefix("data: ").strip())
            for initial in (initial_a, initial_b):
                assert initial["type"] == "status"
                assert initial["job"]["id"] == job.id
                assert initial["job"]["status"] == "running"
            assert job_listener_count(job.id) == 2

            def produce() -> None:
                job.publish({"type": "progress", "message": "A"})
                job.publish({"type": "progress", "message": "B"})
                job.status = "ok"
                job.publish({"type": "done", "job": job.snapshot()})

            await asyncio.to_thread(produce)
            results_a = [initial_a]
            results_b = [initial_b]
            for stream, results in ((stream_a, results_a), (stream_b, results_b)):
                while results[-1]["type"] != "done":
                    frame = await stream.__anext__()
                    results.append(json.loads(frame.removeprefix("data: ").strip()))
            return results_a, results_b
        finally:
            await asyncio.gather(stream_a.aclose(), stream_b.aclose())

    results_a, results_b = asyncio.run(scenario())
    for results in (results_a, results_b):
        assert [ev["type"] for ev in results] == ["status", "progress", "progress", "done"]
        assert [ev.get("message") for ev in results[1:3]] == ["A", "B"]
    assert job_listener_count(job.id) == 0


def test_terminal_job_streams_status_then_done() -> None:
    job = _FakeJob(id="terminal", status="ok")
    events = asyncio.run(_collect(job))
    assert [ev["type"] for ev in events] == ["status", "done"]
    assert job_listener_count(job.id) == 0


def test_keepalive_snapshots_then_done_on_terminal() -> None:
    job = _FakeJob(id="keepalive", status="running")

    async def scenario() -> list[dict]:
        out: list[dict] = []
        async for frame in stream_job_events(job, keepalive_sec=0.02):
            payload = json.loads(frame.removeprefix("data: ").strip())
            out.append(payload)
            if payload["type"] == "status" and len(out) >= 2:
                job.status = "error"
            if payload["type"] == "done":
                break
        return out

    events = asyncio.run(scenario())
    assert events[0]["type"] == "status"
    assert events[-1]["type"] == "done"
    assert all(ev["type"] == "status" for ev in events[:-1])


def test_aclose_unsubscribes() -> None:
    job = _FakeJob(id="aclose", status="running")

    async def scenario() -> None:
        gen = stream_job_events(job, keepalive_sec=5.0)
        await gen.__anext__()
        assert job_listener_count(job.id) == 1
        await gen.aclose()

    asyncio.run(scenario())
    assert job_listener_count(job.id) == 0


def test_publish_without_listener_is_a_noop() -> None:
    job = PipelineJob(
        id="lonely",
        project_path="/tmp/p.json",
        from_step=None,
        only_step=None,
        status="running",
    )
    assert job.has_listeners() is False
    job.publish({"type": "progress"})


def test_subscriber_queue_bounded_drop_oldest() -> None:
    key = "bounded"

    async def scenario() -> tuple[list[Any], list[Any]]:
        loop = asyncio.get_running_loop()
        q1 = job_events_hub().subscribe(key, loop)
        q2 = job_events_hub().subscribe(key, loop)
        try:
            for i in range(JOB_EVENT_QUEUE_MAX + 8):
                publish_job_event(key, {"n": i})

            first1, first2 = await asyncio.wait_for(asyncio.gather(q1.get(), q2.get()), timeout=1.0)
            out1 = [first1]
            while not q1.empty():
                out1.append(q1.get_nowait())
            out2 = [first2]
            while not q2.empty():
                out2.append(q2.get_nowait())
            return out1, out2
        finally:
            job_events_hub().unsubscribe(key, q1)
            job_events_hub().unsubscribe(key, q2)

    out1, out2 = asyncio.run(scenario())
    expected = [{"n": i} for i in range(8, 264)]
    assert out1 == expected
    assert out2 == expected
    assert len(out1) == JOB_EVENT_QUEUE_MAX
    assert len(out2) == JOB_EVENT_QUEUE_MAX


def test_bootstrap_job_publish_goes_through_the_same_hub() -> None:
    job = BootstrapJob(id="boot-events", components=["whisper"])

    async def scenario() -> list[dict]:
        gen = stream_job_events(job, keepalive_sec=5.0)
        out = [json.loads((await gen.__anext__()).removeprefix("data: ").strip())]
        assert job_listener_count(job.id) == 1

        def produce() -> None:
            job.publish({"type": "progress", "message": "downloading"})
            job.status = "ok"
            job.publish({"type": "done", "job": job.snapshot()})

        await asyncio.to_thread(produce)
        async for frame in gen:
            out.append(json.loads(frame.removeprefix("data: ").strip()))
            if out[-1]["type"] == "done":
                break
        return out

    events = asyncio.run(scenario())
    assert [ev["type"] for ev in events] == ["status", "progress", "done"]


def test_live_and_terminal_statuses_partition_the_job_lifecycle() -> None:
    assert LIVE_JOB_STATUSES.isdisjoint(TERMINAL_JOB_STATUSES)
    assert {
        "queued",
        "running",
        "ok",
        "error",
        "cancelled",
    } == LIVE_JOB_STATUSES | TERMINAL_JOB_STATUSES
