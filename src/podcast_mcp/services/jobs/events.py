"""Per-subscriber fan-out and status vocabulary for Studio jobs (pipeline slot, agent, bootstrap).

Each job-events connection subscribes its own bounded queue on a job-id-keyed
:class:`FanoutHub`, so concurrent subscribers never compete for events. Publishing never
blocks the job thread; a slow subscriber drops its own oldest events only. The SSE framing
that reads these queues is the GUI adapter's (``gui/job_events.py``).
"""

from __future__ import annotations

from typing import Any

from podcast_mcp.services.app import FanoutHub

JOB_EVENT_QUEUE_MAX = 256
LIVE_JOB_STATUSES = frozenset({"queued", "running"})
TERMINAL_JOB_STATUSES = frozenset({"ok", "error", "cancelled"})
_HUB = FanoutHub(queue_maxsize=JOB_EVENT_QUEUE_MAX)


def job_events_hub() -> FanoutHub:
    return _HUB


def publish_job_event(job_id: str, event: dict[str, Any]) -> None:
    """Fan *event* out to every live subscriber of *job_id*; no-op without one."""
    _HUB.publish(job_id, event)


def job_listener_count(job_id: str) -> int:
    return _HUB.listener_count(job_id)
