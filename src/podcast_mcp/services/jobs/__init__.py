from typing import TYPE_CHECKING

from podcast_mcp.util.lazy_exports import resolve_export

if TYPE_CHECKING:
    from podcast_mcp.services.jobs.events import (
        JOB_EVENT_QUEUE_MAX,
        LIVE_JOB_STATUSES,
        TERMINAL_JOB_STATUSES,
        job_events_hub,
        job_listener_count,
        publish_job_event,
    )

__all__ = [
    "JOB_EVENT_QUEUE_MAX",
    "LIVE_JOB_STATUSES",
    "TERMINAL_JOB_STATUSES",
    "job_events_hub",
    "job_listener_count",
    "publish_job_event",
]

_MODULE_BY_NAME = {
    "JOB_EVENT_QUEUE_MAX": "events",
    "LIVE_JOB_STATUSES": "events",
    "TERMINAL_JOB_STATUSES": "events",
    "job_events_hub": "events",
    "job_listener_count": "events",
    "publish_job_event": "events",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
