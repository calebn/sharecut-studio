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
    from podcast_mcp.services.jobs.job import (
        KIND_META,
        Job,
        JobKind,
        JobSlotBusyError,
        StepTiming,
        cancelled_copy,
        short_fail_message,
    )

__all__ = [
    "JOB_EVENT_QUEUE_MAX",
    "KIND_META",
    "LIVE_JOB_STATUSES",
    "TERMINAL_JOB_STATUSES",
    "Job",
    "JobKind",
    "JobSlotBusyError",
    "StepTiming",
    "cancelled_copy",
    "job_events_hub",
    "job_listener_count",
    "publish_job_event",
    "short_fail_message",
]

_MODULE_BY_NAME = {
    "JOB_EVENT_QUEUE_MAX": "events",
    "KIND_META": "job",
    "LIVE_JOB_STATUSES": "events",
    "TERMINAL_JOB_STATUSES": "events",
    "Job": "job",
    "JobKind": "job",
    "JobSlotBusyError": "job",
    "StepTiming": "job",
    "cancelled_copy": "job",
    "job_events_hub": "events",
    "job_listener_count": "events",
    "publish_job_event": "events",
    "short_fail_message": "job",
}


def __getattr__(name: str) -> object:
    return resolve_export(name, package=__name__, namespace=globals(), modules=_MODULE_BY_NAME)
